import * as path from 'node:path';
import { Args, Flags } from '@oclif/core';
import { ForgeError, loadWorkspace } from '@forgecli/core';
import { BaseCommand } from '../lib/base';
import { runInWorkspace } from '../lib/cdk';

export default class Test extends BaseCommand {
  static description = 'Run tests — for one module only, or for the whole workspace';

  static examples = ['forge test', 'forge test payments', 'forge test payments --update'];

  static args = {
    module: Args.string({ description: 'run only this module’s tests' }),
  };

  static flags = {
    update: Flags.boolean({
      char: 'u',
      description: 'accept intentional infrastructure changes by updating the CloudFormation snapshots',
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(Test);
    const model = loadWorkspace(process.cwd());

    if (args.module && !model.domains.some((domain) => domain.name === args.module)) {
      throw new ForgeError(
        `Unknown module "${args.module}"`,
        `Available modules: ${model.domains.map((domain) => domain.name).join(', ') || '(none)'}`,
      );
    }

    const vitestArgs = ['vitest', 'run'];
    if (flags.update) vitestArgs.push('-u');
    if (args.module) vitestArgs.push(path.join('domains', args.module).replace(/\\/g, '/'));
    this.exit(runInWorkspace(model.root, 'npx', vitestArgs));
  }
}
