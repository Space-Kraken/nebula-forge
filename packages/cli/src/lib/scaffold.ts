import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  COMPONENT_MANIFEST,
  DOMAIN_MANIFEST,
  ForgeError,
  FUNCTION_LIKE_TYPES,
  isValidName,
  loadWorkspace,
  packComponentDefinition,
  loadPacks,
  toConstructId,
  toEnvVarName,
  WORKSPACE_MANIFEST,
} from '@space-kraken/nebula-forge-core';
import type { Binding, ComponentType, Runtime } from '@space-kraken/nebula-forge-core';
import type { Blueprint } from '@space-kraken/nebula-forge-blueprints';
import { regenerateControllersBarrel, writeEndpointFiles } from './endpoints';
import { engineFor } from './engines';
import { readWorkspaceSettings } from './settings';
import { writeFile, writeJson, writeRendered } from './templates';

export interface ComponentDef {
  name: string;
  /** Built-in type or a pack-provided type. */
  type: ComponentType | (string & {});
  config?: Record<string, unknown>;
  bindings?: Binding[];
}

/**
 * Initial status route for a new http-api. On a shared gateway the route is
 * namespaced by module, so several mounted domains never collide on /status.
 */
function statusRouteFor(moduleName: string, mounted: boolean): string {
  return mounted ? `/${moduleName}/status` : '/status';
}

function assertValidName(kind: string, name: string): void {
  if (!isValidName(name)) {
    throw new ForgeError(
      `Invalid ${kind} name "${name}"`,
      'Names must be kebab-case: lowercase letters and digits separated by dashes (e.g. "order-events").',
    );
  }
}

export interface ScaffoldWorkspaceOptions {
  name: string;
  targetDir: string;
  /** Use file: links to this repo's packages instead of published versions (development). */
  link: boolean;
  /** Synthesis engine for the workspace; defaults to aws-cdk. */
  engine?: string;
  /**
   * Org conventions to inherit: an npm package ("@org/standards/forge",
   * optionally "@1.2.3") or a local path ("./conventions.js"). The npm form
   * lands in devDependencies here; the forge.json key is written by
   * applyConventions once the package can resolve (after install).
   */
  conventions?: string;
}

export interface ConventionsRef {
  /** What forge.json "conventions" receives (package name with subpath, or path). */
  ref: string;
  /** npm package to install (name without subpath), undefined for local paths. */
  packageName?: string;
  /** Exact version to pin when given as name@version; "latest" otherwise. */
  version?: string;
}

/** Parses "--conventions" ("@scope/pkg/forge@1.2.0", "pkg", "./file.js"). */
export function parseConventionsRef(spec: string): ConventionsRef {
  const value = spec.trim();
  if (!value) throw new ForgeError('--conventions needs a package name or a path');
  if (value.startsWith('.') || value.startsWith('/')) return { ref: value };
  const at = value.lastIndexOf('@');
  const [name, version] = at > 0 ? [value.slice(0, at), value.slice(at + 1)] : [value, undefined];
  const segments = name.split('/');
  const packageName = name.startsWith('@') ? segments.slice(0, 2).join('/') : segments[0];
  if (!packageName || (name.startsWith('@') && segments.length < 2)) {
    throw new ForgeError(`Invalid conventions package "${spec}"`, 'Expected <pkg>[/subpath][@version] or a ./path.');
  }
  return { ref: name, packageName, version };
}

/** Writes forge.json "conventions" without loading (the package may not be installed yet). */
export function applyConventionsUnchecked(root: string, ref: string): void {
  const file = path.join(root, WORKSPACE_MANIFEST);
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  const { name, engine, defaultEnvironment, ...rest } = manifest;
  writeJson(file, { name, engine, defaultEnvironment, conventions: ref, ...rest });
}

/**
 * Writes forge.json "conventions" and proves the workspace still loads with
 * it. A failing load restores forge.json byte for byte and rethrows — the
 * contract either applies whole or not at all.
 */
export function applyConventions(root: string, ref: string): void {
  const file = path.join(root, WORKSPACE_MANIFEST);
  const before = fs.readFileSync(file, 'utf8');
  applyConventionsUnchecked(root, ref);
  try {
    loadWorkspace(root);
  } catch (error) {
    fs.writeFileSync(file, before);
    throw error;
  }
}

export function forgeDependency(packageName: string, link: boolean): string {
  if (!link) return '^0.1.0';
  // dist/lib → cli package root → packages/. `link:` (a plain symlink) instead
  // of `file:` so the linked package keeps resolving its own workspace deps
  // from the forge monorepo.
  const packagesRoot = path.resolve(__dirname, '..', '..', '..');
  return `link:${path.join(packagesRoot, packageName).replace(/\\/g, '/')}`;
}

export function scaffoldWorkspace(options: ScaffoldWorkspaceOptions): void {
  assertValidName('workspace', options.name);
  if (fs.existsSync(options.targetDir) && fs.readdirSync(options.targetDir).length > 0) {
    throw new ForgeError(`Directory ${options.targetDir} already exists and is not empty`);
  }
  const adapter = engineFor(options.engine ?? 'aws-cdk');

  const vars = {
    name: options.name,
    engine: adapter.id,
    coreDep: forgeDependency('core', options.link),
    engineDep: forgeDependency(adapter.enginePackage, options.link),
    cliDep: forgeDependency('cli', options.link),
  };

  // Shared files first, then whatever the engine's toolchain needs.
  writeRendered(path.join(options.targetDir, 'tsconfig.json'), 'workspace/tsconfig.json', vars);
  writeRendered(path.join(options.targetDir, 'vitest.config.ts'), 'workspace/vitest.config.ts', vars);
  writeRendered(path.join(options.targetDir, 'pnpm-workspace.yaml'), 'workspace/pnpm-workspace.yaml', vars);
  writeRendered(path.join(options.targetDir, 'README.md'), 'workspace/README.md.tpl', vars);
  for (const file of adapter.workspaceFiles) {
    writeRendered(path.join(options.targetDir, file.target), file.template, vars);
  }
  fs.mkdirSync(path.join(options.targetDir, 'domains'), { recursive: true });

  const conventions = options.conventions ? parseConventionsRef(options.conventions) : undefined;
  if (conventions?.packageName) {
    const packageFile = path.join(options.targetDir, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(packageFile, 'utf8')) as { devDependencies?: Record<string, string> };
    pkg.devDependencies = { ...(pkg.devDependencies ?? {}), [conventions.packageName]: conventions.version ?? 'latest' };
    writeJson(packageFile, pkg);
  }
}

export function scaffoldModule(root: string, name: string, description?: string): string {
  assertValidName('module', name);
  const moduleDir = path.join(root, 'domains', name);
  if (fs.existsSync(moduleDir)) {
    throw new ForgeError(`Module "${name}" already exists at ${moduleDir}`);
  }
  const adapter = engineFor(readWorkspaceSettings(root).engine);

  writeJson(
    path.join(moduleDir, DOMAIN_MANIFEST),
    description ? { name, description } : { name },
  );
  writeRendered(path.join(moduleDir, '__tests__', 'infra.test.ts'), adapter.moduleTestTemplate, {
    module: name,
  });
  return moduleDir;
}

export function scaffoldComponent(
  root: string,
  moduleName: string,
  def: ComponentDef,
  options: { validate?: boolean } = {},
): string {
  assertValidName('component', def.name);
  const moduleDir = path.join(root, 'domains', moduleName);
  if (!fs.existsSync(path.join(moduleDir, DOMAIN_MANIFEST))) {
    throw new ForgeError(
      `Module "${moduleName}" does not exist`,
      'Create it first with `forge generate module <name>`.',
    );
  }
  const componentDir = path.join(moduleDir, 'components', def.name);
  if (fs.existsSync(componentDir)) {
    throw new ForgeError(`Component "${moduleName}/${def.name}" already exists`);
  }
  const settings = readWorkspaceSettings(root);
  const adapter = engineFor(settings.engine);
  loadPacks(root, settings.packs);
  const packDefinition = packComponentDefinition(def.type);
  if (packDefinition && !packDefinition.engines[adapter.id]) {
    throw new ForgeError(
      `Pack component type "${def.type}" (pack "${packDefinition.pack}") has no ${adapter.id} builder`,
      'The pack must provide engines["' + adapter.id + '"] to be usable on this workspace.',
    );
  }
  if (adapter.unsupportedTypes.includes(def.type as ComponentType)) {
    throw new ForgeError(
      `Component type "${def.type}" is not supported by the ${adapter.id} engine yet`,
      `Supported everywhere: function, queue-worker, table, bucket, topic, event-bus.`,
    );
  }
  const runtime = ((def.config as { runtime?: Runtime } | undefined)?.runtime ??
    settings.runtime ??
    adapter.defaultRuntime) as Runtime;
  if (FUNCTION_LIKE_TYPES.includes(def.type as ComponentType) && !adapter.runtimes.includes(runtime)) {
    throw new ForgeError(
      `Runtime "${runtime}" is not available on the ${adapter.id} engine`,
      `Available runtimes: ${adapter.runtimes.join(', ')}.` +
        (runtime === 'ts-fusion' ? ' fusion-azure is not released yet — use the plain "ts" runtime.' : ''),
    );
  }

  const config: Record<string, unknown> = { ...(def.config ?? {}) };
  // The generated fusion controller exposes the status route, and fusion
  // routes by exact httpMethod + resource match — routes must mirror it.
  const statusRoute = statusRouteFor(moduleName, Boolean((def.config as { mount?: string } | undefined)?.mount));
  if (def.type === 'http-api' && !config.routes) {
    // Health checks stay reachable even when an authorizer protects the API.
    config.routes = [{ method: 'GET', path: statusRoute, public: true }];
  }
  const manifest: Record<string, unknown> = { name: def.name, type: def.type };
  if (Object.keys(config).length > 0) manifest.config = config;
  if (def.bindings && def.bindings.length > 0) manifest.bindings = def.bindings;
  writeJson(path.join(componentDir, COMPONENT_MANIFEST), manifest);

  const vars = {
    name: def.name,
    module: moduleName,
    pascalName: toConstructId(def.name),
    screamingName: toEnvVarName(def.name),
  };
  for (const file of adapter.componentFiles(def.type as ComponentType, runtime)) {
    writeRendered(path.join(componentDir, file.target(def.name)), file.template, vars);
  }
  for (const file of packDefinition?.scaffold ?? []) {
    let content = file.content;
    for (const [key, value] of Object.entries(vars)) {
      content = content.split(`{{${key}}}`).join(value);
    }
    writeFile(path.join(componentDir, file.path), content);
  }
  if (def.type === 'http-api') {
    // The module's API Lambda starts with a status endpoint, generated through
    // the same machinery as `forge generate endpoint` (route matches config).
    writeEndpointFiles(componentDir, { name: 'status', method: 'GET', route: statusRoute }, runtime);
    regenerateControllersBarrel(componentDir);
  }

  if (options.validate !== false) {
    try {
      loadWorkspace(root);
    } catch (error) {
      // Leave the workspace as it was before the invalid component was added.
      fs.rmSync(componentDir, { recursive: true, force: true });
      throw error;
    }
  }
  return componentDir;
}

export function applyBlueprint(root: string, blueprint: Blueprint): void {
  for (const domain of blueprint.domains) {
    scaffoldModule(root, domain.name, domain.description);
    for (const component of domain.components) {
      scaffoldComponent(root, domain.name, component, { validate: false });
    }
  }
  loadWorkspace(root);
}

/**
 * Initializes a Vite app inside a static-site component (app/) and points
 * config.sourceDir at its build output. Falls back gracefully when create-vite
 * fails (offline, etc.) — the placeholder site stays usable.
 */
export function initViteFrontend(
  root: string,
  moduleName: string,
  componentName: string,
  template: string,
  log: (message: string) => void,
): boolean {
  const componentDir = path.join(root, 'domains', moduleName, 'components', componentName);
  const result = spawnSync('pnpm', ['create', 'vite@latest', 'app', '--template', template], {
    cwd: componentDir,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (result.status !== 0) {
    log('⚠ create-vite failed — keeping the placeholder site/ (you can retry manually).');
    return false;
  }
  const manifestFile = path.join(componentDir, COMPONENT_MANIFEST);
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')) as Record<string, any>;
  manifest.config = { ...(manifest.config ?? {}), sourceDir: 'app/dist' };
  fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  fs.rmSync(path.join(componentDir, 'site'), { recursive: true, force: true });
  loadWorkspace(root);
  return true;
}

/** Parses repeated --bind flags of the form "<component>:<access>". */
export function parseBindings(values: string[] | undefined): Binding[] {
  if (!values) return [];
  return values.map((value) => {
    const separator = value.lastIndexOf(':');
    if (separator <= 0 || separator === value.length - 1) {
      throw new ForgeError(
        `Invalid binding "${value}"`,
        'Use the form <component>:<access>, e.g. --bind data:read-write or --bind jobs:publish.',
      );
    }
    return {
      component: value.slice(0, separator),
      access: value.slice(separator + 1),
    } as Binding;
  });
}
