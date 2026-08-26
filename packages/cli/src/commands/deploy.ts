import { Args, Flags } from '@oclif/core';
import { loadWorkspace } from '@forgecli/core';
import { BaseCommand } from '../lib/base';
import { resolveEnvironment, resolveStacks, runCdk } from '../lib/cdk';

export default class Deploy extends BaseCommand {
  static description = 'Deploy one module (or all of them with --all) to an environment';

  static examples = ['forge deploy payments', 'forge deploy payments --env prod', 'forge deploy --all --env dev'];

  static args = {
    module: Args.string({ description: 'module to deploy; omit with --all to deploy everything' }),
  };

  static flags = {
    env: Flags.string({ char: 'e', description: 'target environment (defaults to defaultEnvironment)' }),
    all: Flags.boolean({ description: 'deploy every module' }),
    yes: Flags.boolean({ char: 'y', description: 'skip CloudFormation security approval prompts' }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(Deploy);
    const model = loadWorkspace(process.cwd());
    const environment = resolveEnvironment(model, flags.env);
    const stacks = resolveStacks(model, args.module, environment, {
      all: flags.all,
      requireExplicitAll: true,
    });

    this.log(`Deploying ${stacks.join(', ')} (environment: ${environment})`);
    const status = runCdk(model, environment, [
      'deploy',
      ...stacks,
      ...(flags.yes ? ['--require-approval', 'never'] : []),
    ]);
    this.exit(status);
  }
}
