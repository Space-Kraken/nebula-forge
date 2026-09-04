import { loadWorkspace, stackNameFor } from '@space-kraken/nebula-forge-core';
import { BaseCommand } from '../lib/base';

export default class List extends BaseCommand {
  static description = 'Show the workspace architecture: modules, components and bindings';

  static examples = ['forge list'];

  async run(): Promise<void> {
    const model = this.loadModel();

    this.log(`${model.name} (engine: ${model.engine})`);
    const environments = Object.entries(model.environments)
      .map(([name, spec]) => `${name} (${spec.region}${spec.production ? ', production' : ''})`)
      .join(', ');
    this.log(`environments: ${environments}`);
    this.log('');

    if (model.domains.length === 0) {
      this.log('No modules yet. Create one with `forge generate module <name>`.');
      return;
    }

    for (const domain of model.domains) {
      this.log(`${domain.name} — stack ${stackNameFor(model.name, domain.name, model.defaultEnvironment)}`);
      for (const component of domain.components) {
        const relations = component.bindings.map((binding) => `→ ${binding.component} (${binding.access})`);
        if (component.type === 'queue-worker' || component.type === 'function') {
          for (const subscription of component.config.subscriptions) {
            relations.push(`⇐ ${subscription.bus} (subscribed)`);
          }
        }
        if (component.type === 'http-api' && component.config.mount) {
          relations.push(`⇒ ${component.config.mount} (mounted)`);
        }
        if ((component.type === 'gateway' || component.type === 'http-api') && component.config.auth) {
          relations.push(`🔒 ${component.config.auth} (auth)`);
        }
        if (component.type === 'static-site' && component.config.api) {
          relations.push(`⇒ ${component.config.api} (serves /api/*)`);
        }
        if (component.type === 'static-site' && component.config.media) {
          relations.push(`⇒ ${component.config.media} (serves /media/*)`);
        }
        if (
          (component.type === 'static-site' || component.type === 'gateway' || component.type === 'http-api') &&
          component.config.domain
        ) {
          relations.push(`🌐 ${component.config.domain.name}`);
        }
        this.log(`  ${component.name.padEnd(16)} ${component.type.padEnd(14)} ${relations.join(' ')}`.trimEnd());
      }
      for (const component of domain.packComponents ?? []) {
        this.log(`  ${component.name.padEnd(16)} ${component.type.padEnd(14)} (pack ${component.pack})`);
      }
      this.log('');
    }
  }
}
