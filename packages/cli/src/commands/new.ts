import * as path from 'node:path';
import { Args, Flags } from '@oclif/core';
import { getBlueprint, listBlueprints } from '@space-kraken/nebula-forge-blueprints';
import { BaseCommand } from '../lib/base';
import { ForgeError } from '@space-kraken/nebula-forge-core';
import { engineFor, ENGINES } from '../lib/engines';
import { detectPackageManager, runInWorkspace } from '../lib/proc';
import { writeArchitectureDocs } from '../lib/docs';
import { canPrompt, promptInput, promptSelect } from '../lib/interactive';
import {
  applyBlueprint,
  applyConventions,
  applyConventionsUnchecked,
  parseConventionsRef,
  scaffoldWorkspace,
} from '../lib/scaffold';

export default class New extends BaseCommand {
  static description =
    'Create a new forge workspace: a scalable, domain-separated AWS project where each module deploys as its own stack';

  static examples = [
    'forge new my-app',
    'forge new my-app --blueprint serverless-api',
    'forge new my-app --blueprint queue-processing --skip-install',
    'forge new acme-shop --conventions @acme/cloud-standards/forge@1.2.0',
  ];

  static args = {
    name: Args.string({ description: 'workspace name (kebab-case); prompted when omitted on a terminal' }),
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
    profile: Flags.string({
      description: 'AWS named profile the toolchain uses (aws-cdk engine; empty = default credentials)',
    }),
    subscription: Flags.string({
      description: 'Azure subscription id (azure-terraform engine; empty = current az account)',
    }),
    conventions: Flags.string({
      description:
        'inherit the org naming/tags/deploy contract: an npm package (name[/subpath][@version], pinned in devDependencies) or a ./path',
    }),
    'skip-install': Flags.boolean({ description: 'do not install dependencies after scaffolding' }),
    'no-interactive': Flags.boolean({ description: 'never prompt; use flags only' }),
    link: Flags.boolean({
      description: 'link @space-kraken/nebula-forge packages from a local checkout (forge development only)',
      hidden: true,
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(New);
    let wsName = args.name;
    if (!wsName) {
      if (!canPrompt(flags['no-interactive'])) {
        throw new ForgeError('Missing workspace name', 'Usage: forge new <name>');
      }
      wsName = (await promptInput('Workspace name (kebab-case):')).trim();
    }
    const targetDir = path.resolve(process.cwd(), wsName);
    const adapter = engineFor(flags.engine);

    if (flags.profile && adapter.credentials.flag !== 'profile') {
      throw new ForgeError(`--profile does not apply to the ${adapter.id} engine`, 'Use --subscription instead.');
    }
    if (flags.subscription && adapter.credentials.flag !== 'subscription') {
      throw new ForgeError(`--subscription does not apply to the ${adapter.id} engine`, 'Use --profile instead.');
    }
    let credential = adapter.credentials.flag === 'profile' ? flags.profile : flags.subscription;
    if (!credential && canPrompt(flags['no-interactive'])) {
      credential = (await promptInput(adapter.credentials.promptMessage)).trim() || undefined;
    }

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

    const conventions = flags.conventions ? parseConventionsRef(flags.conventions) : undefined;
    scaffoldWorkspace({
      name: wsName,
      targetDir,
      link: flags.link,
      engine: flags.engine,
      conventions: flags.conventions,
    });
    this.log(`✔ Created workspace ${wsName} (engine: ${flags.engine})`);

    if (credential) {
      adapter.credentials.write(targetDir, credential);
      this.log(
        `✔ Environments use ${adapter.credentials.flag} "${credential}" (per-environment overrides in forge.json)`,
      );
    }

    if (blueprintId) {
      const blueprint = getBlueprint(blueprintId);
      applyBlueprint(targetDir, blueprint);
      this.log(`✔ Applied blueprint "${blueprint.name}"`);
    }

    // An npm conventions package only resolves after install, so the key is
    // written (and the docs rendered with its names) once that has run.
    let installed = false;
    if (flags['skip-install']) {
      this.log('↷ Skipped dependency install');
    } else {
      const packageManager = detectPackageManager();
      this.log(`Installing dependencies with ${packageManager} (this can take a couple of minutes)…`);
      const status = runInWorkspace(targetDir, packageManager, ['install']);
      installed = status === 0;
      if (!installed) {
        this.warn(`${packageManager} install failed — run it manually inside the workspace.`);
      }
    }

    let contractLoaded = true;
    if (conventions) {
      if (conventions.packageName && !installed) {
        // Keep the key the user asked for; loading has to wait for install.
        applyConventionsUnchecked(targetDir, conventions.ref);
        contractLoaded = false;
        this.warn(
          `Conventions "${conventions.ref}" recorded in forge.json but not loaded yet: run the install, then "forge docs".`,
        );
      } else {
        try {
          applyConventions(targetDir, conventions.ref);
        } catch (error) {
          const cause = error as ForgeError;
          throw new ForgeError(
            `${cause.message}
Workspace ${wsName} was created WITHOUT the conventions key.`,
            `${cause.hint ? `${cause.hint} ` : ''}Once fixed, add "conventions": "${conventions.ref}" to forge.json and run forge docs.`,
          );
        }
        this.log(`✔ Inheriting conventions from ${conventions.ref}`);
      }
    }

    if (contractLoaded) {
      writeArchitectureDocs(targetDir);
      this.log('✔ Generated docs/architecture.md');
    }

    this.log('');
    this.log('Next steps:');
    this.log(`  cd ${wsName}`);
    if (!blueprintId) {
      this.log('  forge generate module <name>');
      this.log('  forge generate component <name> --module <name> --type http-api');
    }
    this.log('  forge list');
    this.log('  forge test');
    this.log('  forge deploy <module> --env dev');
  }
}
