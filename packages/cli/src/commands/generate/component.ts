import * as fs from 'node:fs';
import { Args, Flags } from '@oclif/core';
import {
  BINDABLE_ACCESS,
  ForgeError,
  FUNCTION_LIKE_TYPES,
  loadWorkspace,
} from '@forgecli/core';
import type { Binding, BindingAccess, ComponentType, DomainSpec, WorkspaceModel } from '@forgecli/core';
import { BaseCommand } from '../../lib/base';
import { attachBinding, parseAttaches, parseSubscribes } from '../../lib/attach';
import { promptBusSubscription, promptOutboundBindings } from '../../lib/coupling-prompts';
import { writeArchitectureDocs } from '../../lib/docs';
import { canPrompt, promptCheckbox, promptInput, promptSelect } from '../../lib/interactive';
import { parseBindings, scaffoldComponent } from '../../lib/scaffold';

const COMPONENT_TYPES: ComponentType[] = [
  'function',
  'http-api',
  'queue-worker',
  'table',
  'bucket',
  'topic',
  'static-site',
  'event-bus',
  'gateway',
  'auth',
  'email',
];

const SUBSCRIBER_TYPES: ComponentType[] = ['queue-worker', 'function'];

export default class GenerateComponent extends BaseCommand {
  static description =
    'Generate a component inside a module. On a terminal, forge infers the possible attachments (who uses it, what it uses, event subscriptions) and asks; every answer is also available as a flag for scripts and CI.';

  static examples = [
    'forge generate component api --module payments --type http-api',
    'forge generate component orders --module payments --type table --attach api:read-write',
    'forge generate component notifier --module payments --type queue-worker --bind orders:read-write --subscribe platform/events:source=payments',
  ];

  static args = {
    name: Args.string({ description: 'component name (kebab-case)', required: true }),
  };

  static flags = {
    module: Flags.string({ char: 'm', description: 'module that owns the component', required: true }),
    type: Flags.string({
      char: 't',
      description: 'component type',
      required: true,
      options: COMPONENT_TYPES,
    }),
    'partition-key': Flags.string({
      description: 'partition key attribute (table components only)',
      default: 'id',
    }),
    bind: Flags.string({
      description: 'bind the NEW component to a sibling (or domain/bus) as <component>:<access> (repeatable)',
      multiple: true,
    }),
    attach: Flags.string({
      description: 'give an EXISTING component access to the new one, as <consumer>:<access> (repeatable)',
      multiple: true,
    }),
    subscribe: Flags.string({
      description: 'subscribe the new worker/function to an event bus: <bus>:source=a,b[:detail-type=X] (repeatable)',
      multiple: true,
    }),
    mount: Flags.string({
      description: 'mount the new http-api on a shared gateway: <gateway> or <domain>/<gateway>',
    }),
    runtime: Flags.string({
      description: 'handler flavor: ts-fusion (TypeScript on fusion) or ts (plain hexagonal TypeScript)',
      options: ['ts-fusion', 'ts'],
    }),
    auth: Flags.string({
      description: 'protect the new gateway/http-api with an auth component from the same module',
    }),
    identity: Flags.string({
      description: 'verified sender for email components: an address (no-reply@app.com) or a domain (app.com)',
    }),
    'no-interactive': Flags.boolean({ description: 'never prompt; use flags only' }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(GenerateComponent);
    const model = loadWorkspace(process.cwd());
    const domain = model.domains.find((candidate) => candidate.name === flags.module);
    if (!domain) {
      throw new ForgeError(
        `Unknown module "${flags.module}"`,
        `Available modules: ${model.domains.map((d) => d.name).join(', ') || '(none — forge generate module <name>)'}`,
      );
    }
    const type = flags.type as ComponentType;

    const bindings = parseBindings(flags.bind);
    const attaches = parseAttaches(flags.attach);
    const subscriptions = parseSubscribes(flags.subscribe);

    if (subscriptions.length > 0 && !SUBSCRIBER_TYPES.includes(type)) {
      throw new ForgeError(
        `--subscribe does not apply to ${type} components`,
        'Only queue-worker and function components can subscribe to event buses.',
      );
    }
    if (flags.mount && type !== 'http-api') {
      throw new ForgeError(
        `--mount does not apply to ${type} components`,
        'Only http-api components mount on a shared gateway.',
      );
    }
    if (flags.runtime && !FUNCTION_LIKE_TYPES.includes(type)) {
      throw new ForgeError(
        `--runtime does not apply to ${type} components`,
        'Only function, http-api and queue-worker components run code.',
      );
    }
    if (flags.auth && type !== 'gateway' && type !== 'http-api') {
      throw new ForgeError(
        `--auth does not apply to ${type} components`,
        'Auth protects gateways and http-apis.',
      );
    }
    let mount = flags.mount;

    let identity = flags.identity;
    if (type === 'email' && !identity) {
      if (!canPrompt(flags['no-interactive'])) {
        throw new ForgeError(
          'Email components need a sender identity',
          'Pass --identity no-reply@your-app.com (or a whole domain like your-app.com).',
        );
      }
      identity = (await promptInput('Sender identity (address or domain):')).trim();
    }

    if (canPrompt(flags['no-interactive'])) {
      if (type === 'http-api' && !mount) {
        mount = await this.promptMount(model, domain, args.name);
      }
      if (FUNCTION_LIKE_TYPES.includes(type) && bindings.length === 0) {
        bindings.push(...(await promptOutboundBindings(model, domain, args.name)));
      }
      if (BINDABLE_ACCESS[type] && attaches.length === 0) {
        attaches.push(...(await this.promptConsumers(domain, args.name, type)));
      }
      if (SUBSCRIBER_TYPES.includes(type) && subscriptions.length === 0) {
        subscriptions.push(
          ...(await promptBusSubscription(model, domain, args.name, (message) => this.warn(message))),
        );
      }
    }

    // Everything an attach could get wrong is checkable before writing files —
    // fail here so a bad flag never leaves a half-created component behind.
    this.validateAttaches(domain, args.name, type, attaches);

    const config: Record<string, unknown> = {};
    if (type === 'table') config.partitionKey = { name: flags['partition-key'] };
    if (subscriptions.length > 0) config.subscriptions = subscriptions;
    if (mount) config.mount = mount;
    if (flags.runtime) config.runtime = flags.runtime;
    if (flags.auth) config.auth = flags.auth;
    if (type === 'email' && identity) config.identity = identity;

    const componentDir = scaffoldComponent(model.root, flags.module, {
      name: args.name,
      type,
      config: Object.keys(config).length > 0 ? config : undefined,
      bindings,
    });
    this.log(`✔ Created component ${flags.module}/${args.name} (${type})`);

    try {
      for (const attach of attaches) {
        const added = attachBinding(model.root, flags.module, attach.consumer, {
          component: args.name,
          access: attach.access,
        });
        this.log(
          added
            ? `✔ Attached ${attach.consumer} → ${args.name} (${attach.access})`
            : `↷ ${attach.consumer} already binds ${args.name}`,
        );
      }
    } catch (error) {
      // Keep the command transactional: undo the scaffold so a corrected
      // retry is not blocked by "component already exists".
      fs.rmSync(componentDir, { recursive: true, force: true });
      writeArchitectureDocs(model.root);
      this.warn(`Rolled back ${flags.module}/${args.name} — no attach was applied.`);
      throw error;
    }
    for (const subscription of subscriptions) {
      this.log(`✔ Subscribed ${args.name} to ${subscription.bus}`);
    }
    if (mount) {
      this.log(`✔ Mounted ${args.name} on gateway ${mount}`);
    }

    writeArchitectureDocs(model.root);
    this.log('✔ Updated docs/architecture.md');
    this.log('');
    this.log('Verify the module still synthesizes (--update accepts the intentional infra snapshot change):');
    this.log(`  forge test ${flags.module} --update`);
  }

  private validateAttaches(
    domain: DomainSpec,
    newName: string,
    newType: ComponentType,
    attaches: { consumer: string; access: BindingAccess }[],
  ): void {
    if (attaches.length === 0) return;
    const allowed = BINDABLE_ACCESS[newType];
    if (!allowed) {
      throw new ForgeError(
        `--attach cannot target a new ${newType}: components of that type cannot be a binding target`,
        `Bindable types: ${Object.keys(BINDABLE_ACCESS).join(', ')}.`,
      );
    }
    for (const attach of attaches) {
      if (!allowed.includes(attach.access)) {
        throw new ForgeError(
          `Access "${attach.access}" is not supported when binding to a ${newType} (allowed: ${allowed.join(', ')})`,
        );
      }
      const consumer = domain.components.find((component) => component.name === attach.consumer);
      if (!consumer) {
        throw new ForgeError(
          `--attach consumer "${attach.consumer}" does not exist in module "${domain.name}"`,
          `Existing components: ${domain.components.map((c) => c.name).join(', ') || '(none)'}.`,
        );
      }
      if (!FUNCTION_LIKE_TYPES.includes(consumer.type)) {
        throw new ForgeError(
          `--attach consumer "${attach.consumer}" is a ${consumer.type} and cannot declare bindings`,
          'Only function, http-api and queue-worker components can bind to other components.',
        );
      }
    }
  }

  /** "Own API Gateway, or hang off a shared one?" */
  private async promptMount(
    model: WorkspaceModel,
    domain: DomainSpec,
    newName: string,
  ): Promise<string | undefined> {
    const gateways = model.domains.flatMap((candidate) =>
      candidate.components
        .filter((component) => component.type === 'gateway')
        .map((component) =>
          candidate.name === domain.name ? component.name : `${candidate.name}/${component.name}`,
        ),
    );
    if (gateways.length === 0) return undefined;
    return promptSelect<string | undefined>(`Mount ${newName} on a shared gateway?`, [
      { name: 'no — provision its own API Gateway', value: undefined },
      ...gateways.map((gateway) => ({ name: gateway, value: gateway })),
    ]);
  }

  /** "Which existing components should use the new resource?" */
  private async promptConsumers(
    domain: DomainSpec,
    newName: string,
    newType: ComponentType,
  ): Promise<{ consumer: string; access: BindingAccess }[]> {
    const consumers = domain.components.filter((component) => FUNCTION_LIKE_TYPES.includes(component.type));
    if (consumers.length === 0) return [];

    const selected = await promptCheckbox(
      `Which components of ${domain.name} should use ${newName}?`,
      consumers.map((component) => ({ name: `${component.name} (${component.type})`, value: component.name })),
    );
    const allowed = BINDABLE_ACCESS[newType] ?? [];
    const results: { consumer: string; access: BindingAccess }[] = [];
    for (const consumer of selected) {
      const access =
        allowed.length === 1
          ? allowed[0]
          : await promptSelect<BindingAccess>(
              `Access for ${consumer} → ${newName}:`,
              allowed.map((mode) => ({ name: mode, value: mode })),
              'read-write' as BindingAccess,
            );
      results.push({ consumer, access });
    }
    return results;
  }

}
