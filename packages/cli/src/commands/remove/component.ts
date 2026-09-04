import { Args, Flags } from '@oclif/core';
import { loadWorkspace, ForgeError } from '@space-kraken/nebula-forge-core';
import { BaseCommand } from '../../lib/base';
import { writeArchitectureDocs } from '../../lib/docs';
import { canPrompt, promptConfirm } from '../../lib/interactive';
import { removeComponent } from '../../lib/remove';

export default class RemoveComponent extends BaseCommand {
  static description =
    'Remove a component and its files. Refuses while other components still couple to it (--force detaches them first).';

  static examples = ['forge remove component files --module orders', 'forge remove component events --module platform --force --yes'];

  static args = {
    name: Args.string({ description: 'component to remove', required: true }),
  };

  static flags = {
    module: Flags.string({ char: 'm', description: 'module that owns the component', required: true }),
    force: Flags.boolean({ description: 'also detach every binding/subscription that references it' }),
    yes: Flags.boolean({ char: 'y', description: 'do not ask for confirmation' }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(RemoveComponent);
    const model = this.loadModel();

    if (!flags.yes) {
      if (!canPrompt(false)) {
        throw new ForgeError(
          'Removing a component deletes its files (including your business logic)',
          'Pass --yes to confirm in non-interactive mode.',
        );
      }
      const confirmed = await promptConfirm(
        `Delete ${flags.module}/${args.name} and all of its files?`,
        false,
      );
      if (!confirmed) {
        this.log('Aborted — nothing was removed.');
        return;
      }
    }

    const detached = removeComponent(model.root, flags.module, args.name, { force: flags.force });
    for (const referrer of detached) {
      this.log(`✔ Detached ${referrer.domain}/${referrer.component} ${referrer.kind === 'binding' ? '→' : '⇐'} ${referrer.ref}`);
    }
    this.log(`✔ Removed component ${flags.module}/${args.name}`);

    writeArchitectureDocs(model.root);
    this.log('✔ Updated docs/architecture.md');
    this.log('');
    this.log('Verify the module still synthesizes (--update accepts the intentional infra snapshot change):');
    this.log(`  forge test ${flags.module} --update`);
  }
}
