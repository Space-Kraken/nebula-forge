import { createRequire } from 'node:module';
import * as path from 'node:path';
import type { ZodType } from 'zod';
import { ForgeError } from './errors';
import type { Binding, BindingAccess } from './model';

/**
 * Component packs — forge's modding system. A pack is an npm package (or a
 * local path) that default-exports a ComponentPack, adding new component
 * types to a workspace without forking forge. V1 packs are PASSIVE resources:
 * bindable targets with no handler code of their own.
 */

export interface PackBindableSpec {
  /** Access modes function-like components may request when binding. */
  access: BindingAccess[];
  /** Discovery env var convention, e.g. { prefix: 'SECRET', suffix: 'ARN' }. */
  envVar: { prefix: string; suffix: string };
}

export interface PackScaffoldFile {
  /** Target path relative to the component dir; {{name}}/{{module}} are replaced. */
  path: string;
  content: string;
}

export interface PackComponentDefinition {
  /** New component type (kebab-case, must not collide with built-ins or other packs). */
  type: string;
  description?: string;
  /** Zod schema for component.json config (make it strict, give defaults). */
  configSchema: ZodType;
  bindable?: PackBindableSpec;
  docs?: { badge?: string; shape?: { open: string; close: string } };
  scaffold?: PackScaffoldFile[];
  /**
   * Builders per engine id. Typed by each engine package (aws-cdk:
   * AwsPackBuilder from @space-kraken/nebula-forge-engine-cdk). Missing engine = the type is
   * rejected on that engine.
   */
  engines: Record<string, unknown>;
}

export interface ComponentPack {
  name: string;
  components: PackComponentDefinition[];
}

export interface RegisteredPackComponent extends PackComponentDefinition {
  pack: string;
}

/** A loaded pack component instance (parallel to ComponentSpec for built-ins). */
export interface PackComponentSpec {
  name: string;
  type: string;
  description?: string;
  /** Always empty in v1 — pack components are passive. Kept for symmetry. */
  bindings: Binding[];
  config: Record<string, unknown>;
  path: string;
  pack: string;
}

const registry = new Map<string, RegisteredPackComponent>();

export function resetPacks(): void {
  registry.clear();
}

export function registerPack(pack: ComponentPack): void {
  for (const component of pack.components) {
    const existing = registry.get(component.type);
    if (existing && existing.pack !== pack.name) {
      throw new ForgeError(
        `Component type "${component.type}" is declared by both pack "${existing.pack}" and pack "${pack.name}"`,
        'Rename the type in one of the packs, or drop one of them from forge.json "packs".',
      );
    }
    registry.set(component.type, { ...component, pack: pack.name });
  }
}

export function packComponentDefinition(type: string): RegisteredPackComponent | undefined {
  return registry.get(type);
}

export function packComponentTypes(): string[] {
  return [...registry.keys()];
}

/**
 * (Re)loads the packs a workspace declares in forge.json "packs". Entries are
 * npm package names (resolved from the workspace's node_modules) or relative
 * paths ("./packs/my-pack") for local pack development.
 */
export function loadPacks(root: string, packNames: readonly string[] | undefined): void {
  resetPacks();
  if (!packNames || packNames.length === 0) return;
  const workspaceRequire = createRequire(path.join(root, 'package.json'));
  for (const name of packNames) {
    const target = name.startsWith('.') ? path.resolve(root, name) : name;
    let loaded: { default?: ComponentPack } & ComponentPack;
    try {
      loaded = workspaceRequire(target);
    } catch (error) {
      throw new ForgeError(
        `Could not load pack "${name}": ${(error as Error).message}`,
        'Install it in the workspace (pnpm add <pack>) or fix the path in forge.json "packs".',
      );
    }
    const pack = (loaded.default ?? loaded) as ComponentPack;
    if (!pack?.name || !Array.isArray(pack.components)) {
      throw new ForgeError(
        `Pack "${name}" does not export a valid ComponentPack`,
        'A pack default-exports { name, components: [{ type, configSchema, engines, … }] }.',
      );
    }
    registerPack(pack);
  }
}
