import { createRequire } from 'node:module';
import * as path from 'node:path';
import { ForgeError } from './errors';
import type { NamingConfig } from './names';
import { conventionsSchema } from './schema';

/**
 * Inherited org conventions (forge.json "conventions"): the naming/tag
 * contract lives ONCE, in a package the platform team owns, and every
 * workspace inherits it instead of copying it. Same resolution mechanism as
 * component packs: an npm package name (workspace node_modules) or a
 * relative path for local development.
 */

export interface ConventionSet {
  naming?: NamingConfig;
  tags?: Record<string, string>;
}

export interface ResolvedConventions extends ConventionSet {
  /** Human-readable warnings the CLI surfaces (e.g. overrides in effect). */
  warnings: string[];
}

export function loadConventions(root: string, ref: string): ConventionSet {
  const workspaceRequire = createRequire(path.join(root, 'package.json'));
  const target = ref.startsWith('.') ? path.resolve(root, ref) : ref;
  let loaded: unknown;
  try {
    loaded = workspaceRequire(target);
  } catch (error) {
    throw new ForgeError(
      `Could not load conventions "${ref}": ${(error as Error).message}`,
      'Install the package in the workspace (pnpm add <pkg>) or fix the path in forge.json "conventions".',
    );
  }
  const exported = (loaded as { default?: unknown }).default ?? loaded;
  const parsed = conventionsSchema.safeParse(exported);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`);
    throw new ForgeError(
      `Conventions "${ref}" does not export a valid contract: ${issues.join('; ')}`,
      'A conventions module exports { naming?: { pattern?, separator? }, tags?: { key: value } } — the same shapes forge.json accepts inline.',
    );
  }
  return parsed.data;
}

/**
 * Merges the inherited contract with the workspace's explicit overrides.
 * naming is atomic (a pattern is all-or-nothing); tags merge per key so a
 * workspace can ADD tags without re-copying the org's mandatory ones.
 */
export function resolveConventions(
  manifest: {
    conventions?: string;
    overrides?: ConventionSet;
    naming?: NamingConfig;
    tags?: Record<string, string>;
  },
  root: string,
): ResolvedConventions {
  if (!manifest.conventions) {
    if (manifest.overrides) {
      throw new ForgeError(
        'forge.json declares "overrides" without "conventions"',
        'overrides only makes sense against an inherited contract. Without conventions, put naming/tags at the top level.',
      );
    }
    return { naming: manifest.naming, tags: manifest.tags, warnings: [] };
  }

  for (const key of ['naming', 'tags'] as const) {
    if (manifest[key] !== undefined) {
      throw new ForgeError(
        `forge.json declares "conventions" AND an inline "${key}" block`,
        `The contract lives in the conventions package. To deviate deliberately, move it under "overrides": { "${key}": … } — the deviation loads with a visible warning.`,
      );
    }
  }

  const inherited = loadConventions(root, manifest.conventions);
  const warnings: string[] = [];
  const overrides = manifest.overrides;
  if (overrides?.naming || (overrides?.tags && Object.keys(overrides.tags).length > 0)) {
    const parts = [overrides.naming ? 'naming' : undefined, overrides.tags ? 'tags' : undefined]
      .filter(Boolean)
      .join(' and ');
    warnings.push(
      `overrides in effect: this workspace deviates from "${manifest.conventions}" (${parts}). The org contract is not fully inherited.`,
    );
  }
  return {
    naming: overrides?.naming ?? inherited.naming,
    tags:
      inherited.tags || overrides?.tags
        ? { ...(inherited.tags ?? {}), ...(overrides?.tags ?? {}) }
        : undefined,
    warnings,
  };
}
