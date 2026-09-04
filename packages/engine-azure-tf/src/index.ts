import * as fs from 'node:fs';
import * as path from 'node:path';
import { stackNameFor } from '@space-kraken/nebula-forge-core';
import type { Engine, SynthOptions, SynthResult, WorkspaceModel } from '@space-kraken/nebula-forge-core';
import { AZURE_UNSUPPORTED_TYPES, synthesizeDomain } from './domain';
import { packageFunction } from './packaging';

export { AZURE_UNSUPPORTED_TYPES, synthesizeDomain } from './domain';
export { packageFunction } from './packaging';
export { applyExtension } from './extend';
export type { AzureExtendContext, AzureExtendFunction } from './extend';
export { toNcrontab } from './schedule';
export { globalName, resourceGroupName, storageAccountName } from './names';

/**
 * Writes one Terraform root module per domain (main.tf.json + function zips)
 * under outdir/<domain>/. Terraform state stays out of the synthesized tree,
 * so re-synthesizing never touches it.
 */
export async function synthesize(model: WorkspaceModel, options: SynthOptions): Promise<SynthResult> {
  const outdir = options.outdir ?? path.join(model.root, '.forge', 'azure', options.environment);
  const domains = options.domains
    ? model.domains.filter((domain) => options.domains!.includes(domain.name))
    : model.domains;

  const stacks: SynthResult['stacks'] = [];
  for (const domain of domains) {
    const document = synthesizeDomain(model, domain.name, options.environment);
    const domainDir = path.join(outdir, domain.name);
    fs.mkdirSync(domainDir, { recursive: true });
    fs.writeFileSync(path.join(domainDir, 'main.tf.json'), `${JSON.stringify(document, null, 2)}\n`);

    const assetsDir = path.join(domainDir, 'assets');
    for (const component of domain.components) {
      if (component.type === 'function' || component.type === 'queue-worker') {
        fs.mkdirSync(assetsDir, { recursive: true });
        packageFunction(component, path.join(assetsDir, `${component.name}.zip`));
      }
    }
    stacks.push({ domain: domain.name, stackName: stackNameFor(model.name, domain.name, options.environment) });
  }
  return { outdir, stacks };
}

export const azureTfEngine: Engine = {
  id: 'azure-terraform',
  synth: synthesize,
};
