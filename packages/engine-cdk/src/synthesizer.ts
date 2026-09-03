import { App } from 'aws-cdk-lib';
import { configureNaming, ForgeError, stackNameFor } from '@forgecli/core';
import type { Engine, SynthOptions, WorkspaceModel } from '@forgecli/core';
import { DomainStack } from './domain-stack';

export interface CreateAppResult {
  app: App;
  /** Domain name → synthesized stack. */
  stacks: Map<string, DomainStack>;
}

export function createApp(model: WorkspaceModel, options: SynthOptions): CreateAppResult {
  // Names must render with THIS workspace's convention, even when the model
  // was built without loadWorkspace (tests, embedding).
  configureNaming(model.naming);
  const envSpec = model.environments[options.environment];
  if (!envSpec) {
    throw new ForgeError(
      `Environment "${options.environment}" is not declared in forge.json`,
      `Available environments: ${Object.keys(model.environments).join(', ')}`,
    );
  }

  if (options.domains) {
    for (const name of options.domains) {
      if (!model.domains.some((domain) => domain.name === name)) {
        throw new ForgeError(
          `Unknown domain "${name}"`,
          `Available domains: ${model.domains.map((domain) => domain.name).join(', ') || '(none)'}`,
        );
      }
    }
  }
  const selected = options.domains
    ? model.domains.filter((domain) => options.domains!.includes(domain.name))
    : model.domains;

  const app = new App({ outdir: options.outdir });
  const stacks = new Map<string, DomainStack>();
  for (const domain of selected) {
    const stackName = stackNameFor(model.name, domain.name, options.environment);
    stacks.set(
      domain.name,
      new DomainStack(app, stackName, {
        model,
        domain,
        environment: options.environment,
        description: domain.description,
        env: envSpec.account
          ? { account: envSpec.account, region: envSpec.region }
          : { region: envSpec.region },
      }),
    );
  }
  return { app, stacks };
}

export const cdkEngine: Engine = {
  id: 'aws-cdk',
  async synth(model, options) {
    const { app, stacks } = createApp(model, options);
    const assembly = app.synth();
    return {
      outdir: assembly.directory,
      stacks: [...stacks.entries()].map(([domain, stack]) => ({ domain, stackName: stack.stackName })),
    };
  },
};
