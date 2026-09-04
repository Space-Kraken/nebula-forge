import { Args, Flags } from '@oclif/core';
import { ForgeError, loadWorkspace } from '@space-kraken/nebula-forge-core';
import { BaseCommand } from '../../lib/base';
import { writeArchitectureDocs } from '../../lib/docs';
import { canPrompt, promptConfirm, promptSelect } from '../../lib/interactive';
import { removeEndpoint } from '../../lib/remove';

export default class RemoveEndpoint extends BaseCommand {
  static description = 'Remove an endpoint: its API Gateway route, controller, use case and test';

  static examples = ['forge remove endpoint get-order --module orders', 'forge remove endpoint get-order --module orders --yes'];

  static args = {
    name: Args.string({ description: 'endpoint to remove', required: true }),
  };

  static flags = {
    module: Flags.string({ char: 'm', description: 'module that owns the API', required: true }),
    api: Flags.string({
      description: 'http-api component that owns the endpoint (inferred when the module has exactly one)',
    }),
    yes: Flags.boolean({ char: 'y', description: 'do not ask for confirmation' }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(RemoveEndpoint);
    const model = this.loadModel();
    const domain = model.domains.find((candidate) => candidate.name === flags.module);
    if (!domain) {
      throw new ForgeError(
        `Unknown module "${flags.module}"`,
        `Available modules: ${model.domains.map((d) => d.name).join(', ') || '(none)'}`,
      );
    }

    const apis = domain.components.filter((component) => component.type === 'http-api');
    let apiName = flags.api;
    if (!apiName) {
      if (apis.length === 1) apiName = apis[0].name;
      else if (apis.length === 0) {
        throw new ForgeError(`Module "${flags.module}" has no http-api component`);
      } else if (canPrompt(false)) {
        apiName = await promptSelect(
          'Which API owns the endpoint?',
          apis.map((api) => ({ name: api.name, value: api.name })),
        );
      } else {
        throw new ForgeError(
          `Module "${flags.module}" has several http-api components (${apis.map((a) => a.name).join(', ')})`,
          'Pick one with --api.',
        );
      }
    }

    if (!flags.yes) {
      if (!canPrompt(false)) {
        throw new ForgeError(
          'Removing an endpoint deletes its controller, use case and test (including your business logic)',
          'Pass --yes to confirm in non-interactive mode.',
        );
      }
      const confirmed = await promptConfirm(
        `Delete endpoint "${args.name}" from ${flags.module}/${apiName} (controller + use case + test)?`,
        false,
      );
      if (!confirmed) {
        this.log('Aborted — nothing was removed.');
        return;
      }
    }

    const removed = removeEndpoint(model.root, flags.module, apiName, args.name);
    this.log(`✔ Removed ${removed.method} ${removed.route} from ${flags.module}/${apiName}`);

    writeArchitectureDocs(model.root);
    this.log('✔ Updated docs/architecture.md');
    this.log('');
    this.log('Verify the module still synthesizes (--update accepts the intentional infra snapshot change):');
    this.log(`  forge test ${flags.module} --update`);
  }
}
