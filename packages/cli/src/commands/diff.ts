import { Args, Flags } from '@oclif/core';
import { loadWorkspace } from '@space-kraken/nebula-forge-core';
import { BaseCommand } from '../lib/base';
import { engineFor } from '../lib/engines';
import { resolveDomains, resolveEnvironment } from '../lib/selection';

export default class Diff extends BaseCommand {
  static description = 'Show what a deployment would change, per module';

  static examples = ['forge diff payments', 'forge diff payments --env prod'];

  static args = {
    module: Args.string({ description: 'module to diff; omit to diff every module' }),
  };

  static flags = {
    env: Flags.string({ char: 'e', description: 'target environment (defaults to defaultEnvironment)' }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(Diff);
    const model = this.loadModel();
    const environment = resolveEnvironment(model, flags.env);
    const domains = resolveDomains(model, args.module, { all: true, requireExplicitAll: false });
    this.exit(await engineFor(model.engine).diff(model, environment, domains));
  }
}
