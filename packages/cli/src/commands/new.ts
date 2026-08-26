import * as path from 'node:path';
import { Args, Flags } from '@oclif/core';
import { getBlueprint, listBlueprints } from '@forgecli/blueprints';
import { BaseCommand } from '../lib/base';
import { ENGINES } from '../lib/engines';
import { detectPackageManager, runInWorkspace } from '../lib/proc';
import { writeArchitectureDocs } from '../lib/docs';
import { canPrompt, promptSelect } from '../lib/interactive';
import { applyBlueprint, scaffoldWorkspace } from '../lib/scaffold';

export default class New extends BaseCommand {
  static description =
    'Create a new forge workspace: a scalable, domain-separated AWS project where each module deploys as its own stack';

  static examples = [
    'forge new my-app',
    'forge new my-app --blueprint serverless-api',
    'forge new my-app --blueprint queue-processing --skip-install',
  ];

  static args = {
    name: Args.string({ description: 'workspace name (kebab-case)', required: true }),
  };

  static flags = {
    blueprint: Flags.string({
      char: 'b',
      description: 'start from a reference architecture blueprint',
      options: listBlueprints().map((blueprint) => blueprint.id),
    }),
    engine: Flags.string({
      description: 'synthesis engine for the workspace',
      options: Object.keys(ENGINES),
      default: 'aws-cdk',
    }),
    'skip-install': Flags.boolean({ description: 'do not install dependencies after scaffolding' }),
    'no-interactive': Flags.boolean({ description: 'never prompt; use flags only' }),
    link: Flags.boolean({
      description: 'link @forgecli packages from a local checkout (forge development only)',
      hidden: true,
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(New);
    const targetDir = path.resolve(process.cwd(), args.name);

    let blueprintId = flags.blueprint;
    if (!blueprintId && canPrompt(flags['no-interactive'])) {
      blueprintId = await promptSelect<string | undefined>('Start from a blueprint?', [
        { name: 'empty workspace', value: undefined },
        ...listBlueprints().map((blueprint) => ({
          name: `${blueprint.id} — ${blueprint.description}`,
          value: blueprint.id,
        })),
      ]);
    }

    scaffoldWorkspace({ name: args.name, targetDir, link: flags.link, engine: flags.engine });
    this.log(`✔ Created workspace ${args.name} (engine: ${flags.engine})`);

    if (blueprintId) {
      const blueprint = getBlueprint(blueprintId);
      applyBlueprint(targetDir, blueprint);
      this.log(`✔ Applied blueprint "${blueprint.name}"`);
    }

    writeArchitectureDocs(targetDir);
    this.log('✔ Generated docs/architecture.md');

    if (flags['skip-install']) {
      this.log('↷ Skipped dependency install');
    } else {
      const packageManager = detectPackageManager();
      this.log(`Installing dependencies with ${packageManager} (this can take a couple of minutes)…`);
      const status = runInWorkspace(targetDir, packageManager, ['install']);
      if (status !== 0) {
        this.warn(`${packageManager} install failed — run it manually inside the workspace.`);
      }
    }

    this.log('');
    this.log('Next steps:');
    this.log(`  cd ${args.name}`);
    if (!blueprintId) {
      this.log('  forge generate module <name>');
      this.log('  forge generate component <name> --module <name> --type http-api');
    }
    this.log('  forge list');
    this.log('  forge test');
    this.log('  forge deploy <module> --env dev');
  }
}
