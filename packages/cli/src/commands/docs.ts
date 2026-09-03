import { Flags } from '@oclif/core';
import { loadWorkspace, renderArchitectureMermaid } from '@forgecli/core';
import { BaseCommand } from '../lib/base';
import { ARCHITECTURE_DOC, writeArchitectureDocs } from '../lib/docs';

export default class Docs extends BaseCommand {
  static description =
    'Generate architecture documentation: docs/architecture.md with a Mermaid diagram and one section per module';

  static examples = ['forge docs', 'forge docs --print'];

  static flags = {
    print: Flags.boolean({
      description: 'print the Mermaid diagram to stdout instead of writing the doc',
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(Docs);
    const model = this.loadModel();

    if (flags.print) {
      this.log(renderArchitectureMermaid(model));
      return;
    }

    writeArchitectureDocs(model.root);
    this.log(`✔ Wrote ${ARCHITECTURE_DOC}`);
    this.log('The diagram renders natively on GitHub/GitLab; it is regenerated on every forge new/generate.');
  }
}
