import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ForgeError } from '@forgecli/core';
import type { WorkspaceModel } from '@forgecli/core';
import { runInWorkspace } from '../proc';
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

export const azureTerraformEngine: EngineAdapter = {
  id: 'azure-terraform',
  enginePackage: 'engine-azure-tf',
  unsupportedTypes: ['http-api', 'static-site'],
  workspaceFiles: [
    { template: 'engines/azure-terraform/forge.json.tpl', target: 'forge.json' },
    { template: 'engines/azure-terraform/package.json.tpl', target: 'package.json' },
    { template: 'engines/azure-terraform/gitignore', target: '.gitignore' },
    { template: 'engines/azure-terraform/infra/azure.ts', target: 'infra/azure.ts' },
  ],
  moduleTestTemplate: 'engines/azure-terraform/infra.test.ts.tpl',
  componentFiles: {
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
  },
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
