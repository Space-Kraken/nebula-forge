import { Args, Flags } from '@oclif/core';
import { loadWorkspace } from '@forgecli/core';
import { BaseCommand } from '../lib/base';
import { engineFor } from '../lib/engines';
import { resolveDomains, resolveEnvironment } from '../lib/selection';

export default class Synth extends BaseCommand {
  static description = 'Synthesize infrastructure templates without deploying';

  static examples = ['forge synth', 'forge synth payments --env prod'];

  static args = {
    module: Args.string({ description: 'module to synthesize; omit to synthesize every module' }),
  };

  static flags = {
    env: Flags.string({ char: 'e', description: 'target environment (defaults to defaultEnvironment)' }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(Synth);
    const model = this.loadModel();
    const environment = resolveEnvironment(model, flags.env);
    const domains = resolveDomains(model, args.module, { all: true, requireExplicitAll: false });
    this.exit(await engineFor(model.engine).synth(model, environment, domains));
  }
}
