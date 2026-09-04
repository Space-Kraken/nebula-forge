import * as path from 'node:path';
import AdmZip from 'adm-zip';
import { buildSync } from 'esbuild';
import { ForgeError } from '@space-kraken/nebula-forge-core';
import type { ComponentSpec } from '@space-kraken/nebula-forge-core';

const HOST_JSON = {
  version: '2.0',
  extensionBundle: { id: 'Microsoft.Azure.Functions.ExtensionBundle', version: '[4.*, 5.0.0)' },
};

/**
 * Bundles a function-like component into the zip a Function App deploys:
 * esbuild-bundled handler (with @azure/functions inlined), host.json and a
 * minimal package.json.
 */
export function packageFunction(spec: ComponentSpec, outFile: string): void {
  if (spec.type !== 'function' && spec.type !== 'queue-worker') {
    throw new ForgeError(`Component "${spec.name}" (${spec.type}) has no code to package`);
  }
  const entry = path.join(spec.path, spec.config.entry);
  const bundle = buildSync({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    minify: true,
    write: false,
    outdir: 'out',
    // Provided by the Azure Functions host at runtime.
    external: ['@azure/functions-core'],
  });

  const zip = new AdmZip();
  zip.addFile('index.js', Buffer.from(bundle.outputFiles[0].contents));
  zip.addFile('host.json', Buffer.from(`${JSON.stringify(HOST_JSON, null, 2)}\n`));
  zip.addFile(
    'package.json',
    Buffer.from(`${JSON.stringify({ name: spec.name, version: '0.0.0', main: 'index.js' }, null, 2)}\n`),
  );
  zip.writeZip(outFile);
}
