import { stackNameFor } from '@forgecli/core';
import type { WorkspaceModel } from '@forgecli/core';
import { runInWorkspace } from '../proc';
import type { EngineAdapter } from './index';

function runCdk(model: WorkspaceModel, environment: string, args: string[]): number {
  return runInWorkspace(model.root, 'npx', ['cdk', ...args], environment);
}

function stackNames(model: WorkspaceModel, environment: string, domains: string[]): string[] {
  return domains.map((domain) => stackNameFor(model.name, domain, environment));
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
    });
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
    runCdk(model, environment, ['synth', ...stackNames(model, environment, domains)]),
  diff: (model, environment, domains) =>
    runCdk(model, environment, ['diff', ...stackNames(model, environment, domains)]),
  deploy: (model, environment, domains, options) =>
    runCdk(model, environment, [
      'deploy',
      ...stackNames(model, environment, domains),
      ...(options.skipApproval ? ['--require-approval', 'never'] : []),
    ]),
};
