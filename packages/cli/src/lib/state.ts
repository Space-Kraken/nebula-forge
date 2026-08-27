import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadWorkspace, WORKSPACE_MANIFEST } from '@forgecli/core';

export interface StateConfig {
  resourceGroup: string;
  storageAccount: string;
  container: string;
}

/**
 * Persists the remote-state backend for an environment into forge.json —
 * from then on the manifest is the single source of truth the engine reads.
 * Validates the workspace and rolls back on failure.
 */
/**
 * Sets a credential-related field (aws profile / azure subscription-account)
 * on EVERY environment of the workspace — the common team setup. Per-env
 * differences are a forge.json edit away. Validated write with rollback.
 */
export function writeCredentialSetting(root: string, key: 'profile' | 'account', value: string): void {
  const file = path.join(root, WORKSPACE_MANIFEST);
  const before = fs.readFileSync(file, 'utf8');
  const manifest = JSON.parse(before) as Record<string, any>;
  for (const environment of Object.keys(manifest.environments ?? {})) {
    manifest.environments[environment] = { ...manifest.environments[environment], [key]: value };
  }
  fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
  try {
    loadWorkspace(root);
  } catch (error) {
    fs.writeFileSync(file, before);
    throw error;
  }
}

export function writeEnvironmentState(root: string, environment: string, state: StateConfig): void {
  const file = path.join(root, WORKSPACE_MANIFEST);
  const before = fs.readFileSync(file, 'utf8');
  const manifest = JSON.parse(before) as Record<string, any>;
  manifest.environments = manifest.environments ?? {};
  manifest.environments[environment] = { ...(manifest.environments[environment] ?? {}), state };
  fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
  try {
    loadWorkspace(root);
  } catch (error) {
    fs.writeFileSync(file, before);
    throw error;
  }
}
