import { ForgeError } from '@forgecli/core';
import type { WorkspaceModel } from '@forgecli/core';
import { awsCdkEngine } from './aws-cdk';

export interface EngineWorkspaceFile {
  /** Template path relative to the CLI templates/ directory. */
  template: string;
  /** Target path relative to the workspace root. */
  target: string;
}

/**
 * A CLI-side engine adapter: which files a workspace of this engine needs and
 * how synth/diff/deploy reach the engine's toolchain. The infrastructure
 * mapping itself lives in the engine package (e.g. @forgecli/engine-cdk) —
 * this layer only dispatches.
 */
export interface EngineAdapter {
  id: string;
  /** Engine-specific files written by `forge new`, on top of the shared set. */
  workspaceFiles: EngineWorkspaceFile[];
  /** Template for the per-module infrastructure test. */
  moduleTestTemplate: string;
  synth(model: WorkspaceModel, environment: string, domains: string[]): number;
  diff(model: WorkspaceModel, environment: string, domains: string[]): number;
  deploy(
    model: WorkspaceModel,
    environment: string,
    domains: string[],
    options: { skipApproval: boolean },
  ): number;
}

export const ENGINES: Record<string, EngineAdapter> = {
  [awsCdkEngine.id]: awsCdkEngine,
};

export function engineFor(engineId: string): EngineAdapter {
  const adapter = ENGINES[engineId];
  if (!adapter) {
    throw new ForgeError(
      `No engine adapter registered for "${engineId}"`,
      `Available engines: ${Object.keys(ENGINES).join(', ')}`,
    );
  }
  return adapter;
}
