import { Stack, Tags } from 'aws-cdk-lib';
import type { StackProps } from 'aws-cdk-lib';
import type { DomainSpec, WorkspaceModel } from '@space-kraken/nebula-forge-core';
import type { Construct } from 'constructs';
import { builtinTagsFor, ForgeError, packComponentDefinition, renderTags } from '@space-kraken/nebula-forge-core';
import { applyBindings, applySubscriptions } from './bindings';
import { buildComponent } from './builders';
import type { BuildContext } from './builders';
import { applyExtension } from './extend';
import type { AwsPackBuilder } from './packs';
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

    // auth builds first (gateways/apis reference its pool); static-site last
    // (its /api/* behavior references the module's built REST API).
    const priority = (spec: { type: string }) =>
      spec.type === 'auth' ? 0 : spec.type === 'static-site' ? 2 : 1;
    const ordered = [...props.domain.components].sort((a, b) => priority(a) - priority(b));
    for (const spec of ordered) {
      this.components.set(spec.name, buildComponent(this, spec, ctx, this.components));
    }
    for (const spec of props.domain.packComponents ?? []) {
      const builder = packComponentDefinition(spec.type)?.engines['aws-cdk'] as AwsPackBuilder | undefined;
      if (!builder) {
        throw new ForgeError(
          `Pack component "${props.domain.name}/${spec.name}" (${spec.type}) has no aws-cdk builder`,
          'The pack must provide engines["aws-cdk"] to synthesize on this engine.',
        );
      }
      const built = builder(this, spec, ctx);
      this.components.set(spec.name, { spec, ...built });
    }
    applyBindings(this, ctx, this.components);
    applySubscriptions(this, ctx, this.components);
    applyExtension({
      stack: this,
      model: props.model,
      domain: props.domain,
      environment: props.environment,
      components: this.components,
    });

    // forge's identity tags (renameable/disableable via tags.builtin) plus
    // the org's workspace tags, applied to every taggable resource.
    const identityTags = builtinTagsFor(
      { app: 'forge:app', domain: 'forge:domain', environment: 'forge:environment' },
      props.model.tags,
      { app: props.model.name, domain: props.domain.name, environment: props.environment },
    );
    const workspaceTags = renderTags(props.model.tags, {
      project: props.model.name,
      module: props.domain.name,
      env: props.environment,
    });
    for (const [key, value] of Object.entries({ ...identityTags, ...workspaceTags })) {
      Tags.of(this).add(key, value);
    }
  }
}
