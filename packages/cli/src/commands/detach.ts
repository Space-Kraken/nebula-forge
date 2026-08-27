import { Args, Flags } from '@oclif/core';
import { ForgeError, loadWorkspace } from '@forgecli/core';
import { BaseCommand } from '../lib/base';
import { detachBinding, detachMount, detachSubscription } from '../lib/attach';
import { writeArchitectureDocs } from '../lib/docs';
import { canPrompt, promptCheckbox } from '../lib/interactive';

interface Coupling {
  kind: 'binding' | 'subscription' | 'mount';
  ref: string;
  label: string;
}

export default class Detach extends BaseCommand {
  static description = 'Detach couplings from a component: remove bindings or event-bus subscriptions';

  static examples = [
    'forge detach api --module orders --bind data',
    'forge detach processor --module billing --subscribe platform/events',
    'forge detach api --module orders',
  ];

  static args = {
    component: Args.string({ description: 'component to detach couplings from', required: true }),
  };

  static flags = {
    module: Flags.string({ char: 'm', description: 'module that owns the component', required: true }),
    bind: Flags.string({ description: 'binding target to remove (repeatable)', multiple: true }),
    subscribe: Flags.string({ description: 'event bus subscription to remove (repeatable)', multiple: true }),
    mount: Flags.boolean({ description: 'unmount from the shared gateway (back to its own API Gateway)' }),
    'no-interactive': Flags.boolean({ description: 'never prompt; use flags only' }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(Detach);
    const model = loadWorkspace(process.cwd());
    const domain = model.domains.find((candidate) => candidate.name === flags.module);
    const component = domain?.components.find((candidate) => candidate.name === args.component);
    if (!domain || !component) {
      throw new ForgeError(`Component "${flags.module}/${args.component}" does not exist`);
    }

    let couplings: Coupling[] = [
      ...(flags.bind ?? []).map((ref): Coupling => ({ kind: 'binding', ref, label: `→ ${ref}` })),
      ...(flags.subscribe ?? []).map((ref): Coupling => ({ kind: 'subscription', ref, label: `⇐ ${ref}` })),
      ...(flags.mount ? [{ kind: 'mount', ref: '(gateway)', label: '⇒ gateway mount' } as Coupling] : []),
    ];

    if (couplings.length === 0) {
      const current: Coupling[] = component.bindings.map((binding) => ({
        kind: 'binding',
        ref: binding.component,
        label: `→ ${binding.component} (${binding.access})`,
      }));
      if (component.type === 'queue-worker' || component.type === 'function') {
        for (const subscription of component.config.subscriptions) {
          current.push({ kind: 'subscription', ref: subscription.bus, label: `⇐ ${subscription.bus} (subscribed)` });
        }
      }
      if (component.type === 'http-api' && component.config.mount) {
        current.push({ kind: 'mount', ref: component.config.mount, label: `⇒ ${component.config.mount} (mounted)` });
      }
      if (current.length === 0) {
        this.log(`Component "${args.component}" has no couplings.`);
        return;
      }
      if (!canPrompt(flags['no-interactive'])) {
        throw new ForgeError(
          'Nothing to detach',
          'Pass --bind <target> and/or --subscribe <bus>, or run on a terminal for interactive mode.',
        );
      }
      couplings = await promptCheckbox(
        `Detach which couplings from ${args.component}?`,
        current.map((coupling) => ({ name: coupling.label, value: coupling })),
      );
      if (couplings.length === 0) {
        this.log('Nothing selected — no changes made.');
        return;
      }
    }

    for (const coupling of couplings) {
      const removed =
        coupling.kind === 'binding'
          ? detachBinding(model.root, flags.module, args.component, coupling.ref)
          : coupling.kind === 'subscription'
            ? detachSubscription(model.root, flags.module, args.component, coupling.ref)
            : detachMount(model.root, flags.module, args.component);
      this.log(
        removed
          ? `✔ Detached ${args.component} ${coupling.kind === 'binding' ? '→' : coupling.kind === 'subscription' ? '⇐' : '⇒'} ${coupling.ref}`
          : `↷ ${args.component} had no ${coupling.kind} to ${coupling.ref}`,
      );
    }

    writeArchitectureDocs(model.root);
    this.log('✔ Updated docs/architecture.md');
  }
}
