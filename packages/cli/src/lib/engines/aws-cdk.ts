import * as fs from 'node:fs';
import * as path from 'node:path';
import { ForgeError, stackNameFor } from '@forgecli/core';
import type { WorkspaceModel } from '@forgecli/core';
import { runInWorkspace, runInWorkspaceRetrying } from '../proc';
import { writeCredentialSetting } from '../state';
import type { EngineAdapter } from './index';

/** The environment's named profile, exported so cdk and the SDK pick it up. */
function profileEnv(model: WorkspaceModel, environment: string): Record<string, string> {
  const profile = model.environments[environment]?.profile;
  return profile ? { AWS_PROFILE: profile } : {};
}

function runCdk(model: WorkspaceModel, environment: string, args: string[]): number {
  return runInWorkspace(model.root, 'npx', ['cdk', ...args], environment, profileEnv(model, environment));
}

/**
 * Windows race: Defender/indexers hold freshly written bundle files while
 * AssetStaging renames its temp dir → intermittent EBUSY on an otherwise
 * healthy synth. Bundling happens before CloudFormation is touched, so a
 * retry is always safe — including for deploy.
 */
const STAGING_EBUSY = /EBUSY: resource busy or locked/;

function runCdkRetrying(model: WorkspaceModel, environment: string, args: string[]): Promise<number> {
  return runInWorkspaceRetrying(model.root, 'npx', ['cdk', ...args], environment, profileEnv(model, environment), {
    pattern: STAGING_EBUSY,
    attempts: 3,
    delayMs: (attempt) => attempt * 1500,
    onRetry: (nextAttempt, total) =>
      console.error(
        `forge: a file lock (EBUSY) interrupted asset staging — retrying (attempt ${nextAttempt}/${total})…`,
      ),
  });
}

function stackNames(model: WorkspaceModel, environment: string, domains: string[]): string[] {
  return domains.map((domain) => stackNameFor(model.name, domain, environment));
}

/** Deploying an unbuilt static-site would ship an empty 403-ing site — refuse. */
export function assertStaticSourcesBuilt(model: WorkspaceModel, domains: string[]): void {
  for (const domain of model.domains) {
    if (!domains.includes(domain.name)) continue;
    for (const component of domain.components) {
      if (component.type !== 'static-site') continue;
      const sourceDir = path.join(component.path, component.config.sourceDir);
      if (!fs.existsSync(sourceDir)) {
        throw new ForgeError(
          `Cannot deploy "${domain.name}": static-site "${component.name}" has no build at "${component.config.sourceDir}"`,
          `Build the frontend first (e.g. cd ${path.relative(model.root, component.path)}/app && pnpm install && pnpm build).`,
        );
      }
    }
  }
}

export const awsCdkEngine: EngineAdapter = {
  id: 'aws-cdk',
  enginePackage: 'engine-cdk',
  unsupportedTypes: [],
  workspaceFiles: [
    { template: 'engines/aws-cdk/forge.json.tpl', target: 'forge.json' },
    { template: 'engines/aws-cdk/package.json.tpl', target: 'package.json' },
    { template: 'engines/aws-cdk/cdk.json', target: 'cdk.json' },
    { template: 'engines/aws-cdk/gitignore', target: '.gitignore' },
    { template: 'engines/aws-cdk/infra/app.ts', target: 'infra/app.ts' },
  ],
  moduleTestTemplate: 'engines/aws-cdk/infra.test.ts.tpl',
  bootstrap: (model, environment, log) => {
    // CDK owns its state (CloudFormation); bootstrap provisions the assets
    // bucket and roles cdk deploy needs, once per account/region.
    const envSpec = model.environments[environment];
    const target = envSpec.account ? [`aws://${envSpec.account}/${envSpec.region}`] : [];
    log(`Bootstrapping AWS environment "${environment}" (region ${envSpec.region}) via cdk bootstrap…`);
    return runInWorkspace(model.root, 'npx', ['cdk', 'bootstrap', ...target], environment, {
      CDK_DEFAULT_REGION: envSpec.region,
      ...profileEnv(model, environment),
    });
  },
  credentials: {
    flag: 'profile',
    promptMessage: 'AWS profile for deployments (empty = default credentials):',
    write: (root, value) => writeCredentialSetting(root, 'profile', value),
  },
  runtimes: ['ts-fusion', 'ts'],
  defaultRuntime: 'ts-fusion',
  componentFiles: (type, runtime) => {
    switch (type) {
      case 'http-api':
        return [{ template: `component/http-api/${runtime}/handler.ts.tpl`, target: () => 'src/handler.ts' }];
      case 'queue-worker':
        return [
          { template: `component/queue-worker/${runtime}/handler.ts.tpl`, target: () => 'src/handler.ts' },
          {
            template: `component/queue-worker/${runtime}/process-message.uc.ts.tpl`,
            target: () => 'src/application/process-message.uc.ts',
          },
          {
            template: `component/queue-worker/${runtime}/message-store.port.ts.tpl`,
            target: () => 'src/domain/ports/message-store.ts',
          },
          {
            template: `component/queue-worker/${runtime}/console-message-store.adapter.ts.tpl`,
            target: () => 'src/infrastructure/adapters/console-message-store.ts',
          },
          { template: `component/queue-worker/${runtime}/handler.test.ts.tpl`, target: () => 'test/handler.test.ts' },
        ];
      case 'function':
        return [
          { template: `component/function/${runtime}/handler.ts.tpl`, target: () => 'src/handler.ts' },
          { template: `component/function/${runtime}/run-task.uc.ts.tpl`, target: () => 'src/application/run-task.uc.ts' },
          { template: `component/function/${runtime}/handler.test.ts.tpl`, target: () => 'test/handler.test.ts' },
        ];
      case 'static-site':
        return [{ template: 'component/static-site/index.html.tpl', target: () => 'site/index.html' }];
      default:
        return [];
    }
  },
  synth: (model, environment, domains) =>
    runCdkRetrying(model, environment, ['synth', ...stackNames(model, environment, domains)]),
  diff: (model, environment, domains) =>
    runCdkRetrying(model, environment, ['diff', ...stackNames(model, environment, domains)]),
  deploy: (model, environment, domains, options) => {
    assertStaticSourcesBuilt(model, domains);
    return runCdkRetrying(model, environment, [
      'deploy',
      ...stackNames(model, environment, domains),
      ...(options.skipApproval ? ['--require-approval', 'never'] : []),
    ]);
  },
};
