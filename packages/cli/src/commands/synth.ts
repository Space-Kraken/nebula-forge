import { Args, Flags } from '@oclif/core';
import { loadWorkspace } from '@forgecli/core';
import { BaseCommand } from '../lib/base';
import { resolveEnvironment, resolveStacks, runCdk } from '../lib/cdk';

export default class Synth extends BaseCommand {
  static description = 'Synthesize CloudFormation templates without deploying';

  static examples = ['forge synth', 'forge synth payments --env prod'];

  static args = {
    module: Args.string({ description: 'module to synthesize; omit to synthesize every module' }),
  };

  static flags = {
    env: Flags.string({ char: 'e', description: 'target environment (defaults to defaultEnvironment)' }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(Synth);
    const model = loadWorkspace(process.cwd());
    const environment = resolveEnvironment(model, flags.env);
    const stacks = resolveStacks(model, args.module, environment, {
      all: true,
      requireExplicitAll: false,
    });
    this.exit(runCdk(model, environment, ['synth', ...stacks]));
  }
}
