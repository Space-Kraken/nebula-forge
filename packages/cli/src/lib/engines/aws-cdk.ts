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
  workspaceFiles: [
    { template: 'engines/aws-cdk/package.json.tpl', target: 'package.json' },
    { template: 'engines/aws-cdk/cdk.json', target: 'cdk.json' },
    { template: 'engines/aws-cdk/gitignore', target: '.gitignore' },
    { template: 'engines/aws-cdk/infra/app.ts', target: 'infra/app.ts' },
  ],
  moduleTestTemplate: 'engines/aws-cdk/infra.test.ts.tpl',
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
