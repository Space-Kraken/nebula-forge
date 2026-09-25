import { createRequire } from 'node:module';
import * as path from 'node:path';
import type { z } from 'zod';
import { ForgeError } from './errors';
import type { NamingConfig, TagsConfig } from './names';
import { conventionsSchema } from './schema';
import type { deploySchema } from './schema';

/**
 * Inherited org conventions (forge.json "conventions"): the naming/tag/deploy
 * contract lives ONCE, in a package the platform team owns, and every
 * workspace inherits it instead of copying it. Same resolution mechanism as
 * component packs: an npm package name (workspace node_modules, subpaths
 * like "@org/standards/forge" included) or a relative path for local
 * development.
 *
 * The module exports either the contract itself or a FUNCTION of the
 * workspace context returning it. The function form is the compatibility
 * seam: an org keeps its own tool-agnostic standards package (its own
 * vocabulary, its own config files) and ships a small adapter that maps
 * them onto forge's contract. Mapping composes into forge's fixed
 * vocabulary; it never widens it.
 */

/** Contract version an adapter targets. Renames bump it; additions do not. */
export const CONVENTIONS_SCHEMA_VERSION = 1;

export type DeployConfig = z.infer<typeof deploySchema>;

export interface ConventionSet {
  schemaVersion?: typeof CONVENTIONS_SCHEMA_VERSION;
  naming?: NamingConfig;
  tags?: TagsConfig;
  /** Per-environment deployment identity (aws-cdk); keyed by environment name. */
  environments?: Record<string, { deploy?: DeployConfig }>;
}

/** What a conventions adapter receives. Pure data: an adapter must be a deterministic function of it. */
export interface ConventionsContext {
  /** Absolute workspace root (where forge.json lives). Org config files are read from here. */
  root: string;
  /** forge.json "name". */
  name: string;
  /** forge.json "engine". */
  engine: string;
  /** forge.json environments WITHOUT deploy: what the workspace declares (accounts, regions). */
  environments: Record<string, { account?: string; region: string }>;
  forge: {
    /** @space-kraken/nebula-forge-core version running the adapter. */
    version: string;
    /** Contract version this forge speaks (CONVENTIONS_SCHEMA_VERSION). */
    conventionsSchemaVersion: typeof CONVENTIONS_SCHEMA_VERSION;
  };
}

export interface ResolvedConventions {
  naming?: NamingConfig;
  tags?: TagsConfig;
  /** Deploy identity per environment after inheritance + overrides (undefined = nothing inherited). */
  deploy?: Record<string, DeployConfig | undefined>;
  /** Human-readable warnings the CLI surfaces (e.g. overrides in effect). */
  warnings: string[];
}

function coreVersion(): string {
  try {
    return (createRequire(__filename)('../package.json') as { version: string }).version;
  } catch {
    return '0.0.0';
  }
}

/**
 * Validates a contract exactly as the loader does (strict shape, known
 * schemaVersion). Exported so an org's adapter can unit-test its output
 * without loading a workspace.
 */
export function validateConventions(value: unknown, ref: string = 'conventions'): ConventionSet {
  const parsed = conventionsSchema.safeParse(value);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`);
    const version = (value as { schemaVersion?: unknown } | null)?.schemaVersion;
    if (version !== undefined && version !== CONVENTIONS_SCHEMA_VERSION) {
      throw new ForgeError(
        `Conventions "${ref}" targets contract schemaVersion ${String(version)}; this forge speaks ${CONVENTIONS_SCHEMA_VERSION}`,
        'Update the conventions package (or forge) so both agree on the contract version.',
      );
    }
    throw new ForgeError(
      `Conventions "${ref}" does not export a valid contract: ${issues.join('; ')}`,
      'A conventions module exports (or returns) { schemaVersion?: 1, naming?: { pattern?, separator? }, tags?: { key: value }, environments?: { <env>: { deploy? } } } — the same shapes forge.json accepts inline.',
    );
  }
  return parsed.data as ConventionSet;
}

export function loadConventions(root: string, ref: string, ctx: ConventionsContext): ConventionSet {
  const workspaceRequire = createRequire(path.join(root, 'package.json'));
  const target = ref.startsWith('.') ? path.resolve(root, ref) : ref;
  let loaded: unknown;
  try {
    loaded = workspaceRequire(target);
  } catch (error) {
    throw new ForgeError(
      `Could not load conventions "${ref}": ${(error as Error).message}`,
      'Install the package in the workspace (pnpm add -D <pkg>) or fix the path in forge.json "conventions".',
    );
  }
  let exported = (loaded as { default?: unknown }).default ?? loaded;
  if (typeof exported === 'function') {
    try {
      exported = (exported as (context: ConventionsContext) => unknown)(ctx);
    } catch (error) {
      throw new ForgeError(
        `Conventions "${ref}" failed: ${(error as Error).message}`,
        'The adapter rejected this workspace. Fix what it reports (usually forge.json or the org config it reads) and retry.',
      );
    }
    if (exported && typeof (exported as { then?: unknown }).then === 'function') {
      throw new ForgeError(
        `Conventions "${ref}" returned a Promise`,
        'Adapters run synchronously inside every forge command: return the contract directly.',
      );
    }
  }
  return validateConventions(exported, ref);
}

/**
 * Merges the inherited contract with the workspace's explicit overrides.
 * naming is atomic (a pattern is all-or-nothing); tags merge per key so a
 * workspace can ADD tags without re-copying the org's mandatory ones; deploy
 * identity replaces per environment (a bootstrap is one thing).
 */
export function resolveConventions(
  manifest: {
    name: string;
    engine: string;
    environments: Record<string, { account?: string; region: string; deploy?: DeployConfig }>;
    conventions?: string;
    overrides?: ConventionSet;
    naming?: NamingConfig;
    tags?: TagsConfig;
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

  const ctx: ConventionsContext = {
    root,
    name: manifest.name,
    engine: manifest.engine,
    environments: Object.fromEntries(
      Object.entries(manifest.environments).map(([env, spec]) => [env, { account: spec.account, region: spec.region }]),
    ),
    forge: { version: coreVersion(), conventionsSchemaVersion: CONVENTIONS_SCHEMA_VERSION },
  };
  const inherited = loadConventions(root, manifest.conventions, ctx);
  const warnings: string[] = [];
  const overrides = manifest.overrides;

  // Deploy identity: once the contract has an opinion on environments, the
  // workspace no longer declares it inline — same rule as naming/tags.
  let deploy: ResolvedConventions['deploy'];
  if (inherited.environments) {
    for (const [env, spec] of Object.entries(manifest.environments)) {
      if (spec.deploy) {
        throw new ForgeError(
          `forge.json declares "conventions" AND an inline "deploy" block on environment "${env}"`,
          `The contract owns deployment identity. To deviate deliberately, move it under "overrides": { "environments": { "${env}": { "deploy": … } } } — the deviation loads with a visible warning.`,
        );
      }
    }
    deploy = {};
    for (const env of Object.keys(manifest.environments)) {
      deploy[env] = overrides?.environments?.[env]?.deploy ?? inherited.environments[env]?.deploy;
    }
  } else if (overrides?.environments) {
    deploy = {};
    for (const env of Object.keys(manifest.environments)) {
      deploy[env] = overrides.environments[env]?.deploy ?? manifest.environments[env].deploy;
    }
  }

  const deviations = [
    overrides?.naming ? 'naming' : undefined,
    overrides?.tags && Object.keys(overrides.tags).length > 0 ? 'tags' : undefined,
    overrides?.environments && Object.keys(overrides.environments).length > 0 ? 'environments' : undefined,
  ].filter(Boolean);
  if (deviations.length > 0) {
    warnings.push(
      `overrides in effect: this workspace deviates from "${manifest.conventions}" (${deviations.join(' and ')}). The org contract is not fully inherited.`,
    );
  }
  return {
    naming: overrides?.naming ?? inherited.naming,
    tags:
      inherited.tags || overrides?.tags
        ? { ...(inherited.tags ?? {}), ...(overrides?.tags ?? {}) }
        : undefined,
    deploy,
    warnings,
  };
}
