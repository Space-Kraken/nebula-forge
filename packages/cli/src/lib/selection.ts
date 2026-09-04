import { ForgeError } from '@space-kraken/nebula-forge-core';
import type { WorkspaceModel } from '@space-kraken/nebula-forge-core';

export function resolveEnvironment(model: WorkspaceModel, requested?: string): string {
  const environment = requested ?? model.defaultEnvironment;
  if (!(environment in model.environments)) {
    throw new ForgeError(
      `Environment "${environment}" is not declared in forge.json`,
      `Available environments: ${Object.keys(model.environments).join(', ')}`,
    );
  }
  return environment;
}

/**
 * Maps a module selection to domain names. Deploy-style commands pass
 * requireExplicitAll so a multi-domain workspace is never deployed wholesale
 * by accident — one domain at a time is the intended workflow.
 */
export function resolveDomains(
  model: WorkspaceModel,
  moduleName: string | undefined,
  options: { all: boolean; requireExplicitAll: boolean },
): string[] {
  if (moduleName) {
    if (!model.domains.some((domain) => domain.name === moduleName)) {
      throw new ForgeError(
        `Unknown module "${moduleName}"`,
        `Available modules: ${model.domains.map((domain) => domain.name).join(', ') || '(none)'}`,
      );
    }
    return [moduleName];
  }
  if (model.domains.length === 0) {
    throw new ForgeError(
      'This workspace has no modules yet',
      'Create one with `forge generate module <name>`.',
    );
  }
  if (model.domains.length > 1 && options.requireExplicitAll && !options.all) {
    throw new ForgeError(
      'Multiple modules found — target one module at a time, or pass --all explicitly',
      `Modules: ${model.domains.map((domain) => domain.name).join(', ')}`,
    );
  }
  return model.domains.map((domain) => domain.name);
}
