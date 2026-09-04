import { Args, Flags } from '@oclif/core';
import { ForgeError, loadWorkspace } from '@space-kraken/nebula-forge-core';
import { BaseCommand } from '../../lib/base';
import { writeArchitectureDocs } from '../../lib/docs';
import { canPrompt, promptConfirm } from '../../lib/interactive';
import { removeModule } from '../../lib/remove';

export default class RemoveModule extends BaseCommand {
  static description =
    'Remove a whole module (domain) and its files. Refuses while other modules couple to it (--force detaches them first).';

  static examples = ['forge remove module reporting', 'forge remove module platform --force --yes'];

  static args = {
    name: Args.string({ description: 'module to remove', required: true }),
  };

  static flags = {
    force: Flags.boolean({ description: 'also detach every cross-module coupling that references it' }),
    yes: Flags.boolean({ char: 'y', description: 'do not ask for confirmation' }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(RemoveModule);
    const model = this.loadModel();

    if (!flags.yes) {
      if (!canPrompt(false)) {
        throw new ForgeError(
          'Removing a module deletes its whole stack definition and code',
          'Pass --yes to confirm in non-interactive mode.',
        );
      }
      const confirmed = await promptConfirm(
        `Delete module "${args.name}" with ALL of its components and code?`,
        false,
      );
      if (!confirmed) {
        this.log('Aborted — nothing was removed.');
        return;
      }
    }

    const detached = removeModule(model.root, args.name, { force: flags.force });
    for (const referrer of detached) {
      this.log(`✔ Detached ${referrer.domain}/${referrer.component} (${referrer.kind} "${referrer.ref}")`);
    }
    this.log(`✔ Removed module ${args.name}`);

    writeArchitectureDocs(model.root);
    this.log('✔ Updated docs/architecture.md');
    this.log('');
    this.log(`Remember: the deployed stack still exists — destroy it with your toolchain if needed.`);
  }
}
