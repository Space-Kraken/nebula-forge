import * as path from 'node:path';
import { loadWorkspace } from '@space-kraken/nebula-forge-core';
import { synthesize } from '@space-kraken/nebula-forge-engine-azure-tf';

// Entry point run by `forge synth/diff/deploy` (via tsx). Writes one
// Terraform root module per domain under .forge/azure/<env>/ — you never
// write or read Terraform yourself; forge drives the toolchain.
const model = loadWorkspace(path.resolve(__dirname, '..'));
const environment = process.env.FORGE_ENV ?? model.defaultEnvironment;

synthesize(model, {
  environment,
  outdir: path.resolve(__dirname, '..', '.forge', 'azure', environment),
}).then(
  (result) => {
    for (const stack of result.stacks) console.log(`synthesized ${stack.stackName}`);
  },
  (error: Error & { hint?: string }) => {
    console.error(error.message);
    if (error.hint) console.error(error.hint);
    process.exit(1);
  },
);
