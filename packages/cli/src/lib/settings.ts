import * as fs from 'node:fs';
import * as path from 'node:path';
import { WORKSPACE_MANIFEST } from '@space-kraken/nebula-forge-core';
import type { Runtime } from '@space-kraken/nebula-forge-core';

export interface WorkspaceSettings {
  engine: string;
  /** Workspace-wide default runtime (forge.json defaults.runtime), if any. */
  runtime?: Runtime;
  /** Component packs declared in forge.json "packs", if any. */
  packs?: string[];
}

/** Cheap read of the workspace's engine/defaults without full validation. */
export function readWorkspaceSettings(root: string): WorkspaceSettings {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, WORKSPACE_MANIFEST), 'utf8')) as {
    engine?: string;
    defaults?: { runtime?: Runtime };
    packs?: string[];
  };
  return {
    engine: manifest.engine ?? 'aws-cdk',
    runtime: manifest.defaults?.runtime,
    packs: manifest.packs,
  };
}
