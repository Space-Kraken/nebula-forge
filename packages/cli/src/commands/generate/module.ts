import { Args } from '@oclif/core';
import { loadWorkspace } from '@forgecli/core';
import { BaseCommand } from '../../lib/base';
import { writeArchitectureDocs } from '../../lib/docs';
import { scaffoldModule } from '../../lib/scaffold';

export default class GenerateModule extends BaseCommand {
  static description =
    'Generate a module (business domain) — an independently deployable and testable stack';

  static examples = ['forge generate module payments'];

  static args = {
    name: Args.string({ description: 'module name (kebab-case)', required: true }),
  };

  async run(): Promise<void> {
    const { args } = await this.parse(GenerateModule);
    const model = loadWorkspace(process.cwd());
    scaffoldModule(model.root, args.name);
    writeArchitectureDocs(model.root);
    this.log(`✔ Created module ${args.name} (stack ${model.name}-${args.name}-<env>)`);
    this.log('✔ Updated docs/architecture.md');
    this.log('');
    this.log('Add components with:');
    this.log(`  forge generate component <name> --module ${args.name} --type http-api`);
  }
}
