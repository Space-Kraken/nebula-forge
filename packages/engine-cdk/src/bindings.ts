import { EventBus, Rule } from 'aws-cdk-lib/aws-events';
import { LambdaFunction as LambdaFunctionTarget, SqsQueue } from 'aws-cdk-lib/aws-events-targets';
import type { IRuleTarget } from 'aws-cdk-lib/aws-events';
import type { IEventBus } from 'aws-cdk-lib/aws-events';
import { bindingEnvVarFor, ForgeError, resolveBinding, resourceNameFor, toConstructId } from '@forgecli/core';
import type { Construct } from 'constructs';
import type { BuildContext } from './builders';
import type { BuiltComponent } from './types';

/**
 * Wires every declared binding: least-privilege IAM grant plus environment
 * variables so handlers can locate the target resource.
 *
 * Same-domain bindings grant against the construct built in this stack.
 * Cross-domain bindings (event buses only, loader-enforced) reference the bus
 * by its deterministic name — no cross-stack exports, so domains keep
 * deploying independently.
 */
export function applyBindings(
  scope: Construct,
  ctx: BuildContext,
  components: Map<string, BuiltComponent>,
): void {
  for (const component of components.values()) {
    if (!component.lambda) continue;
    component.spec.bindings.forEach((binding, index) => {
      const resolved = resolveBinding(ctx.model, ctx.domain, binding);
      if (!resolved) {
        // The loader validates bindings; reaching this means a programming error.
        throw new ForgeError(`Cannot bind "${component.spec.name}" to "${binding.component}": target not found`);
      }

      if (resolved.domain.name === ctx.domain.name) {
        const target = components.get(resolved.component.name);
        if (!target?.grant) {
          throw new ForgeError(
            `Cannot bind "${component.spec.name}" to "${binding.component}": target is not bindable`,
          );
        }
        target.grant(component.lambda!, binding.access);
        for (const [key, value] of Object.entries(target.bindingEnv ?? {})) {
          component.lambda!.addEnvironment(key, value);
        }
        return;
      }

      const busName = resourceNameFor(
        ctx.model.name,
        resolved.domain.name,
        resolved.component.name,
        ctx.environment,
      );
      const bus = EventBus.fromEventBusName(scope, `${toConstructId(component.spec.name)}CrossDomainBus${index}`, busName);
      bus.grantPutEventsTo(component.lambda!);
      const envVar = bindingEnvVarFor('event-bus', `${resolved.domain.name}-${resolved.component.name}`);
      if (envVar) component.lambda!.addEnvironment(envVar, busName);
    });
  }
}

/**
 * EventBridge subscriptions, wired after every component exists. A same-stack
 * bus is referenced as a construct (so CloudFormation orders creation); a bus
 * in another domain is referenced by deterministic name — never by export.
 *
 * queue-worker subscriptions deliver into the worker's queue (retries + DLQ);
 * function subscriptions target the Lambda directly (lighter, no DLQ).
 */
export function applySubscriptions(
  scope: Construct,
  ctx: BuildContext,
  components: Map<string, BuiltComponent>,
): void {
  for (const component of components.values()) {
    const spec = component.spec;
    if (spec.type !== 'queue-worker' && spec.type !== 'function') continue;
    let target: IRuleTarget;
    if (spec.type === 'queue-worker') {
      if (!component.queue) continue;
      target = new SqsQueue(component.queue);
    } else {
      if (!component.lambda) continue;
      target = new LambdaFunctionTarget(component.lambda);
    }
    const id = toConstructId(spec.name);

    spec.config.subscriptions.forEach((subscription, index) => {
      const resolved = resolveBinding(ctx.model, ctx.domain, subscription.bus);
      if (!resolved) {
        // The loader validates subscriptions; reaching this means a programming error.
        throw new ForgeError(`Cannot resolve event bus reference "${subscription.bus}"`);
      }

      let eventBus: IEventBus;
      if (resolved.domain.name === ctx.domain.name) {
        const local = components.get(resolved.component.name)?.eventBus;
        if (!local) {
          throw new ForgeError(`Cannot subscribe "${spec.name}" to "${subscription.bus}": it is not an event bus`);
        }
        eventBus = local;
      } else {
        eventBus = EventBus.fromEventBusName(
          scope,
          `${id}SubscriptionBus${index}`,
          resourceNameFor(ctx.model.name, resolved.domain.name, resolved.component.name, ctx.environment),
        );
      }

      new Rule(scope, `${id}Subscription${index}`, {
        eventBus,
        eventPattern: {
          source: subscription.pattern.source,
          detailType: subscription.pattern.detailType,
        },
        targets: [target],
      });
    });
  }
}
