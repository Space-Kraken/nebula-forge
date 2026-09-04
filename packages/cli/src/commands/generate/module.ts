import { Args, Flags } from '@oclif/core';
import { ForgeError, loadWorkspace } from '@space-kraken/nebula-forge-core';
import { BaseCommand } from '../../lib/base';
import { writeArchitectureDocs } from '../../lib/docs';
import { canPrompt, promptInput } from '../../lib/interactive';
import { scaffoldModule } from '../../lib/scaffold';

export default class GenerateModule extends BaseCommand {
  static description =
    'Generate a module (business domain) — an independently deployable and testable stack';

  static examples = ['forge generate module payments', 'forge g m payments'];

  static aliases = ['g:module', 'g:m', 'gm'];

  static args = {
    name: Args.string({ description: 'module name (kebab-case); prompted when omitted on a terminal' }),
  };

  static flags = {
    'no-interactive': Flags.boolean({ description: 'never prompt; use flags only' }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(GenerateModule);
    const model = this.loadModel();

    let name = args.name;
    if (!name) {
      if (!canPrompt(flags['no-interactive'])) {
        throw new ForgeError('Missing module name', 'Usage: forge generate module <name>');
      }
      name = (await promptInput('Module name (kebab-case):')).trim();
    }

    scaffoldModule(model.root, name);
    writeArchitectureDocs(model.root);
    this.log(`✔ Created module ${name} (stack ${model.name}-${name}-<env>)`);
    this.log('✔ Updated docs/architecture.md');
    this.log('');
    this.log('Add components with:');
    this.log(`  forge generate component <name> --module ${name} --type http-api`);
  }
}
