import { Args, Flags } from '@oclif/core';
import { ForgeError, FUNCTION_LIKE_TYPES, loadWorkspace } from '@forgecli/core';
import { BaseCommand } from '../lib/base';
import { attachBinding, attachSubscription, parseSubscribes } from '../lib/attach';
import { promptBusSubscription, promptOutboundBindings } from '../lib/coupling-prompts';
import { writeArchitectureDocs } from '../lib/docs';
import { canPrompt } from '../lib/interactive';
import { parseBindings } from '../lib/scaffold';

export default class Attach extends BaseCommand {
  static description =
    'Attach couplings to an EXISTING component: bindings to resources (IAM + env vars) or event-bus subscriptions. Interactive on a terminal; flag-driven in CI.';

  static examples = [
    'forge attach api --module orders --bind data:read-write',
    'forge attach processor --module billing --subscribe platform/events:source=orders',
    'forge attach api --module orders',
  ];

  static args = {
    component: Args.string({ description: 'component to attach couplings to', required: true }),
  };

  static flags = {
    module: Flags.string({ char: 'm', description: 'module that owns the component', required: true }),
    bind: Flags.string({
      description: 'bind to a sibling (or domain/bus) as <component>:<access> (repeatable)',
      multiple: true,
    }),
    subscribe: Flags.string({
      description: 'subscribe to an event bus: <bus>:source=a,b[:detail-type=X] (repeatable)',
      multiple: true,
    }),
    'no-interactive': Flags.boolean({ description: 'never prompt; use flags only' }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(Attach);
    const model = loadWorkspace(process.cwd());
    const domain = model.domains.find((candidate) => candidate.name === flags.module);
    const component = domain?.components.find((candidate) => candidate.name === args.component);
    if (!domain || !component) {
      throw new ForgeError(`Component "${flags.module}/${args.component}" does not exist`);
    }

    let bindings = parseBindings(flags.bind);
    let subscriptions = parseSubscribes(flags.subscribe);
    const isFunctionLike = FUNCTION_LIKE_TYPES.includes(component.type);
    const isSubscriber = component.type === 'queue-worker' || component.type === 'function';

    if (bindings.length > 0 && !isFunctionLike) {
      throw new ForgeError(
        `Component "${args.component}" is a ${component.type} and cannot declare bindings`,
        'Only function, http-api and queue-worker components bind to other components.',
      );
    }
    if (subscriptions.length > 0 && !isSubscriber) {
      throw new ForgeError(
        `Component "${args.component}" is a ${component.type} and cannot subscribe to event buses`,
        'Only queue-worker and function components subscribe.',
      );
    }

    if (bindings.length === 0 && subscriptions.length === 0) {
      if (!canPrompt(flags['no-interactive'])) {
        throw new ForgeError(
          'Nothing to attach',
          'Pass --bind and/or --subscribe, or run on a terminal for interactive mode.',
        );
      }
      if (isFunctionLike) {
        const alreadyBound = new Set(component.bindings.map((binding) => binding.component));
        bindings = await promptOutboundBindings(model, domain, args.component, alreadyBound);
      }
      if (isSubscriber) {
        subscriptions = await promptBusSubscription(model, domain, args.component, (message) => this.warn(message));
      }
      if (bindings.length === 0 && subscriptions.length === 0) {
        this.log('Nothing selected — no changes made.');
        return;
      }
    }

    for (const binding of bindings) {
      const added = attachBinding(model.root, flags.module, args.component, binding);
      this.log(
        added
          ? `✔ Attached ${args.component} → ${binding.component} (${binding.access})`
          : `↷ ${args.component} already binds ${binding.component}`,
      );
    }
    for (const subscription of subscriptions) {
      const added = attachSubscription(model.root, flags.module, args.component, subscription);
      this.log(
        added
          ? `✔ Subscribed ${args.component} to ${subscription.bus}`
          : `↷ ${args.component} already has that subscription to ${subscription.bus}`,
      );
    }

    writeArchitectureDocs(model.root);
    this.log('✔ Updated docs/architecture.md');
    this.log('');
    this.log('Verify the module still synthesizes (--update accepts the intentional infra snapshot change):');
    this.log(`  forge test ${flags.module} --update`);
  }
}
