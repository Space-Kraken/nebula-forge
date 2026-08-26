import { Stack, Tags } from 'aws-cdk-lib';
import type { StackProps } from 'aws-cdk-lib';
import type { DomainSpec, WorkspaceModel } from '@forgecli/core';
import type { Construct } from 'constructs';
import { applyBindings, applySubscriptions } from './bindings';
import { buildComponent } from './builders';
import type { BuildContext } from './builders';
import type { BuiltComponent } from './types';

export interface DomainStackProps extends StackProps {
  model: WorkspaceModel;
  domain: DomainSpec;
  environment: string;
}

/**
 * One independently deployable stack per domain: components are created
 * first, then bindings are wired in a second pass.
 */
export class DomainStack extends Stack {
  readonly components = new Map<string, BuiltComponent>();

  constructor(scope: Construct, id: string, props: DomainStackProps) {
    super(scope, id, props);

    const envSpec = props.model.environments[props.environment];
    const ctx: BuildContext = {
      model: props.model,
      domain: props.domain,
      environment: props.environment,
      production: envSpec?.production ?? props.environment === 'prod',
    };

    for (const spec of props.domain.components) {
      this.components.set(spec.name, buildComponent(this, spec, ctx));
    }
    applyBindings(this, ctx, this.components);
    applySubscriptions(this, ctx, this.components);

    Tags.of(this).add('forge:app', props.model.name);
    Tags.of(this).add('forge:domain', props.domain.name);
    Tags.of(this).add('forge:environment', props.environment);
  }
}
