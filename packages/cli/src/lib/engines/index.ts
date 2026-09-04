import { ForgeError } from '@space-kraken/nebula-forge-core';
import type { ComponentType, EngineCapabilityProvider, Runtime, WorkspaceModel } from '@space-kraken/nebula-forge-core';
import { awsCdkEngine } from './aws-cdk';
import { azureTerraformEngine } from './azure-terraform';

export interface EngineWorkspaceFile {
  /** Template path relative to the CLI templates/ directory. */
  template: string;
  /** Target path relative to the workspace root. */
  target: string;
}

export interface EngineComponentFile {
  template: string;
  target: (name: string) => string;
}

/**
 * A CLI-side engine adapter: which files a workspace of this engine needs and
 * how synth/diff/deploy reach the engine's toolchain. The infrastructure
 * mapping itself lives in the engine package (e.g. @space-kraken/nebula-forge-engine-cdk) —
 * this layer only dispatches.
 */
export interface EngineAdapter {
  id: string;
  /** forge package the generated workspace depends on for synthesis. */
  enginePackage: string;
  /** Component types this engine cannot synthesize yet (rejected at generate time). */
  unsupportedTypes: ComponentType[];
  /** Engine-specific files written by `forge new`, on top of the shared set. */
  workspaceFiles: EngineWorkspaceFile[];
  /** Template for the per-module infrastructure test. */
  moduleTestTemplate: string;
  /** How this engine identifies deploy credentials at workspace setup. */
  credentials: {
    /** forge new flag name ("profile" for AWS, "subscription" for Azure). */
    flag: 'profile' | 'subscription';
    promptMessage: string;
    write(root: string, value: string): void;
  };
  /** Handler runtimes this engine can scaffold, and which one applies when nothing chooses. */
  runtimes: Runtime[];
  defaultRuntime: Runtime;
  /** Source files scaffolded for a component of the given type and runtime. */
  componentFiles(type: ComponentType, runtime: Runtime): EngineComponentFile[];
  /**
   * Static engine metadata for `forge model --json`: resource types per
   * component type, domain-shared infra, deterministic physical names and
   * builtin tags. Anti-drift tests assert it against real synthesized output.
   */
  capabilities: EngineCapabilityProvider;
  synth(model: WorkspaceModel, environment: string, domains: string[]): number | Promise<number>;
  diff(model: WorkspaceModel, environment: string, domains: string[]): number | Promise<number>;
  /** Prepares the account/environment: deploy prerequisites and state management. */
  bootstrap(model: WorkspaceModel, environment: string, log: (message: string) => void): number;
  deploy(
    model: WorkspaceModel,
    environment: string,
    domains: string[],
    options: { skipApproval: boolean },
  ): number | Promise<number>;
}

export const ENGINES: Record<string, EngineAdapter> = {
  [awsCdkEngine.id]: awsCdkEngine,
  [azureTerraformEngine.id]: azureTerraformEngine,
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
