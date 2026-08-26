import { Args, Flags } from '@oclif/core';
import { loadWorkspace } from '@forgecli/core';
import { BaseCommand } from '../lib/base';
import { resolveEnvironment, resolveStacks, runCdk } from '../lib/cdk';

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
    const model = loadWorkspace(process.cwd());
    const environment = resolveEnvironment(model, flags.env);
    const stacks = resolveStacks(model, args.module, environment, {
      all: true,
      requireExplicitAll: false,
    });
    this.exit(runCdk(model, environment, ['diff', ...stacks]));
  }
}
