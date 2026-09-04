import { listBlueprints } from '@space-kraken/nebula-forge-blueprints';
import { BaseCommand } from '../lib/base';

export default class Blueprints extends BaseCommand {
  static description = 'List the available architecture blueprints';

  static examples = ['forge blueprints'];

  async run(): Promise<void> {
    for (const blueprint of listBlueprints()) {
      this.log(`${blueprint.id.padEnd(20)} ${blueprint.name}`);
      this.log(`${''.padEnd(20)} ${blueprint.description}`);
      this.log('');
    }
    this.log('Use one with: forge new <name> --blueprint <id>');
  }
}
