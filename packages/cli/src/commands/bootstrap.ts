import { Flags } from '@oclif/core';
import { loadWorkspace } from '@forgecli/core';
import { BaseCommand } from '../lib/base';
import { engineFor } from '../lib/engines';
import { resolveEnvironment } from '../lib/selection';

export default class Bootstrap extends BaseCommand {
  static description =
    'Prepare an environment for deployments: AWS runs cdk bootstrap; Azure provisions a shared Terraform state backend (storage account) and migrates local state. Idempotent.';

  static examples = ['forge bootstrap', 'forge bootstrap --env prod'];

  static flags = {
    env: Flags.string({ char: 'e', description: 'environment to bootstrap (defaults to defaultEnvironment)' }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(Bootstrap);
    const model = loadWorkspace(process.cwd());
    const environment = resolveEnvironment(model, flags.env);
    const code = engineFor(model.engine).bootstrap(model, environment, (message) => this.log(message));
    this.exit(code);
  }
}
