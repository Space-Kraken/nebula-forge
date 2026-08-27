import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ForgeError } from '@forgecli/core';
import type { WorkspaceModel } from '@forgecli/core';
import { commandAvailable, runInWorkspace } from '../proc';
import { writeEnvironmentState } from '../state';
import type { StateConfig } from '../state';
import type { EngineAdapter } from './index';

function ensureTerraform(): void {
  const probe = spawnSync('terraform', ['-version'], {
    shell: process.platform === 'win32',
    stdio: 'ignore',
  });
  if (probe.status !== 0) {
    throw new ForgeError(
      'Terraform CLI not found',
      'forge drives terraform for you, but the binary must be installed: https://developer.hashicorp.com/terraform/install',
    );
  }
}

/** Regenerate .forge/azure/<env>/ (tf.json + function zips) via the workspace's pinned engine. */
function synthesize(model: WorkspaceModel, environment: string): number {
  return runInWorkspace(model.root, 'npx', ['tsx', 'infra/azure.ts'], environment);
}

function terraform(model: WorkspaceModel, environment: string, domain: string, args: string[]): number {
  const chdir = path.join('.forge', 'azure', environment, domain).replace(/\\/g, '/');
  return runInWorkspace(model.root, 'terraform', [`-chdir=${chdir}`, ...args], environment);
}

function perDomain(
  model: WorkspaceModel,
  environment: string,
  domains: string[],
  argsFor: (domain: string) => string[][],
): number {
  ensureTerraform();
  const status = synthesize(model, environment);
  if (status !== 0) return status;
  for (const domain of domains) {
    for (const args of argsFor(domain)) {
      const code = terraform(model, environment, domain, args);
      if (code !== 0) return code;
    }
  }
  return 0;
}

/** Deterministic name for the tfstate storage account (3-24 chars, lowercase alnum, globally unique). */
function stateStorageAccountName(appName: string, environment: string): string {
  const hash = createHash('sha256').update(`${appName}|tfstate|${environment}`).digest('hex').slice(0, 10);
  const base = `st${`${appName}${environment}`.replace(/[^a-z0-9]/g, '')}`.slice(0, 14);
  return `${base}${hash}`.slice(0, 24);
}

function az(model: WorkspaceModel, args: string[]): number {
  return runInWorkspace(model.root, 'az', [...args, '-o', 'none']);
}

function bootstrapAzure(model: WorkspaceModel, environment: string, log: (message: string) => void): number {
  ensureTerraform();
  if (!commandAvailable('az', ['account', 'show'])) {
    throw new ForgeError(
      'Azure CLI not available or not logged in',
      'Install it (https://learn.microsoft.com/cli/azure/install-azure-cli) and run `az login` first.',
    );
  }
  const envSpec = model.environments[environment];
  const state: StateConfig = envSpec.state ?? {
    resourceGroup: `rg-${model.name}-tfstate-${environment}`,
    storageAccount: stateStorageAccountName(model.name, environment),
    container: 'tfstate',
  };

  log(`Ensuring remote state backend (${state.resourceGroup}/${state.storageAccount}/${state.container})…`);
  const steps: string[][] = [
    ['group', 'create', '--name', state.resourceGroup, '--location', envSpec.region],
    [
      'storage', 'account', 'create',
      '--name', state.storageAccount,
      '--resource-group', state.resourceGroup,
      '--location', envSpec.region,
      '--sku', 'Standard_LRS',
      '--kind', 'StorageV2',
      '--min-tls-version', 'TLS1_2',
      '--allow-blob-public-access', 'false',
    ],
    ['storage', 'container', 'create', '--name', state.container, '--account-name', state.storageAccount],
  ];
  for (const step of steps) {
    const code = az(model, step);
    if (code !== 0) return code;
  }

  if (!envSpec.state) {
    writeEnvironmentState(model.root, environment, state);
    log('✔ Recorded the backend in forge.json (environments.' + environment + '.state)');
  }

  log('Re-synthesizing with the remote backend…');
  const synthCode = synthesize(model, environment);
  if (synthCode !== 0) return synthCode;

  for (const domain of model.domains) {
    log(`Migrating state of "${domain.name}"…`);
    const migrate = terraform(model, environment, domain.name, [
      'init', '-input=false', '-migrate-state', '-force-copy',
    ]);
    if (migrate !== 0) {
      // Fresh module (nothing to migrate): plain re-init against the new backend.
      const reinit = terraform(model, environment, domain.name, ['init', '-input=false', '-reconfigure']);
      if (reinit !== 0) return reinit;
    }
  }
  log('✔ Bootstrap complete — state is shared; teammates can deploy after az login.');
  return 0;
}

export const azureTerraformEngine: EngineAdapter = {
  id: 'azure-terraform',
  enginePackage: 'engine-azure-tf',
  unsupportedTypes: ['http-api', 'static-site', 'gateway', 'auth'],
  workspaceFiles: [
    { template: 'engines/azure-terraform/forge.json.tpl', target: 'forge.json' },
    { template: 'engines/azure-terraform/package.json.tpl', target: 'package.json' },
    { template: 'engines/azure-terraform/gitignore', target: '.gitignore' },
    { template: 'engines/azure-terraform/infra/azure.ts', target: 'infra/azure.ts' },
  ],
  moduleTestTemplate: 'engines/azure-terraform/infra.test.ts.tpl',
  bootstrap: bootstrapAzure,
  // Azure templates are plain hexagonal; fusion-azure will add 'ts-fusion'.
  runtimes: ['ts'],
  defaultRuntime: 'ts',
  componentFiles: (type) => AZURE_COMPONENT_FILES[type] ?? [],
  synth: (model, environment) => {
    return synthesize(model, environment) === 0 ? 0 : 1;
  },
  diff: (model, environment, domains) =>
    perDomain(model, environment, domains, () => [
      ['init', '-input=false'],
      ['plan', '-input=false'],
    ]),
  deploy: (model, environment, domains, options) =>
    perDomain(model, environment, domains, () => [
      ['init', '-input=false'],
      ['apply', '-input=false', ...(options.skipApproval ? ['-auto-approve'] : [])],
    ]),
};

const AZURE_COMPONENT_FILES: Partial<Record<string, { template: string; target: (name: string) => string }[]>> = {
  function: [
      { template: 'engines/azure-terraform/component/function/handler.ts.tpl', target: () => 'src/handler.ts' },
      {
        template: 'engines/azure-terraform/component/function/run-task.uc.ts.tpl',
        target: () => 'src/application/run-task.uc.ts',
      },
      { template: 'engines/azure-terraform/component/function/handler.test.ts.tpl', target: () => 'test/handler.test.ts' },
    ],
    'queue-worker': [
      { template: 'engines/azure-terraform/component/queue-worker/handler.ts.tpl', target: () => 'src/handler.ts' },
      {
        template: 'engines/azure-terraform/component/queue-worker/process-message.uc.ts.tpl',
        target: () => 'src/application/process-message.uc.ts',
      },
      {
        template: 'engines/azure-terraform/component/queue-worker/message-store.port.ts.tpl',
        target: () => 'src/domain/ports/message-store.ts',
      },
      {
        template: 'engines/azure-terraform/component/queue-worker/console-message-store.adapter.ts.tpl',
        target: () => 'src/infrastructure/adapters/console-message-store.ts',
      },
      {
        template: 'engines/azure-terraform/component/queue-worker/handler.test.ts.tpl',
        target: () => 'test/handler.test.ts',
      },
    ],
};
