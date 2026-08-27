import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  COMPONENT_MANIFEST,
  DOMAIN_MANIFEST,
  ForgeError,
  FUNCTION_LIKE_TYPES,
  isValidName,
  loadWorkspace,
  toConstructId,
  WORKSPACE_MANIFEST,
} from '@forgecli/core';
import type { Binding, ComponentType, Runtime } from '@forgecli/core';
import type { Blueprint } from '@forgecli/blueprints';
import { regenerateControllersBarrel, writeEndpointFiles } from './endpoints';
import { engineFor } from './engines';
import { readWorkspaceSettings } from './settings';
import { writeJson, writeRendered } from './templates';

export interface ComponentDef {
  name: string;
  type: ComponentType;
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
  if (adapter.unsupportedTypes.includes(def.type)) {
    throw new ForgeError(
      `Component type "${def.type}" is not supported by the ${adapter.id} engine yet`,
      `Supported everywhere: function, queue-worker, table, bucket, topic, event-bus.`,
    );
  }
  const runtime = ((def.config as { runtime?: Runtime } | undefined)?.runtime ??
    settings.runtime ??
    adapter.defaultRuntime) as Runtime;
  if (FUNCTION_LIKE_TYPES.includes(def.type) && !adapter.runtimes.includes(runtime)) {
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
    config.routes = [{ method: 'GET', path: statusRoute }];
  }
  const manifest: Record<string, unknown> = { name: def.name, type: def.type };
  if (Object.keys(config).length > 0) manifest.config = config;
  if (def.bindings && def.bindings.length > 0) manifest.bindings = def.bindings;
  writeJson(path.join(componentDir, COMPONENT_MANIFEST), manifest);

  const vars = { name: def.name, module: moduleName, pascalName: toConstructId(def.name) };
  for (const file of adapter.componentFiles(def.type, runtime)) {
    writeRendered(path.join(componentDir, file.target(def.name)), file.template, vars);
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
