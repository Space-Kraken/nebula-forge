import * as fs from 'node:fs';
import * as path from 'node:path';
import { COMPONENT_MANIFEST, ForgeError, loadWorkspace, resolveBinding } from '@space-kraken/nebula-forge-core';
import type { WorkspaceModel } from '@space-kraken/nebula-forge-core';
import { detachAuth, detachBinding, detachMount, detachSubscription } from './attach';
import { endpointFiles, regenerateControllersBarrel } from './endpoints';
import { writeJson } from './templates';

export interface Referrer {
  domain: string;
  component: string;
  /** The reference exactly as written in the referrer's manifest. */
  ref: string;
  kind: 'binding' | 'subscription' | 'mount' | 'auth';
}

/** Every component that binds to or subscribes to module/name. */
export function findReferrers(model: WorkspaceModel, moduleName: string, componentName: string): Referrer[] {
  const referrers: Referrer[] = [];
  for (const domain of model.domains) {
    for (const component of domain.components) {
      if (domain.name === moduleName && component.name === componentName) continue;
      for (const binding of component.bindings) {
        const resolved = resolveBinding(model, domain, binding);
        if (resolved?.domain.name === moduleName && resolved.component.name === componentName) {
          referrers.push({ domain: domain.name, component: component.name, ref: binding.component, kind: 'binding' });
        }
      }
      if (component.type === 'queue-worker' || component.type === 'function') {
        for (const subscription of component.config.subscriptions) {
          const resolved = resolveBinding(model, domain, subscription.bus);
          if (resolved?.domain.name === moduleName && resolved.component.name === componentName) {
            referrers.push({
              domain: domain.name,
              component: component.name,
              ref: subscription.bus,
              kind: 'subscription',
            });
          }
        }
      }
      if (component.type === 'http-api' && component.config.mount) {
        const resolved = resolveBinding(model, domain, component.config.mount);
        if (resolved?.domain.name === moduleName && resolved.component.name === componentName) {
          referrers.push({ domain: domain.name, component: component.name, ref: component.config.mount, kind: 'mount' });
        }
      }
      if (
        (component.type === 'http-api' || component.type === 'gateway') &&
        component.config.auth === componentName &&
        domain.name === moduleName
      ) {
        referrers.push({ domain: domain.name, component: component.name, ref: component.config.auth, kind: 'auth' });
      }
    }
  }
  return referrers;
}

/**
 * Removes a component. Refuses while other components still couple to it,
 * unless force is set — then those couplings are detached first, so the
 * workspace never holds a dangling reference.
 */
export function removeComponent(
  root: string,
  moduleName: string,
  componentName: string,
  options: { force: boolean },
): Referrer[] {
  const model = loadWorkspace(root);
  const domain = model.domains.find((candidate) => candidate.name === moduleName);
  const component =
    domain?.components.find((candidate) => candidate.name === componentName) ??
    domain?.packComponents?.find((candidate) => candidate.name === componentName);
  if (!domain || !component) {
    throw new ForgeError(`Component "${moduleName}/${componentName}" does not exist`);
  }

  const referrers = findReferrers(model, moduleName, componentName);
  if (referrers.length > 0 && !options.force) {
    const list = referrers
      .map((referrer) => `${referrer.domain}/${referrer.component} (${referrer.kind} "${referrer.ref}")`)
      .join(', ');
    throw new ForgeError(
      `Component "${moduleName}/${componentName}" is still used by: ${list}`,
      'Detach those couplings first (forge detach <component> …) or pass --force to remove them along with the component.',
    );
  }
  for (const referrer of referrers) {
    if (referrer.kind === 'binding') detachBinding(root, referrer.domain, referrer.component, referrer.ref);
    else if (referrer.kind === 'subscription') detachSubscription(root, referrer.domain, referrer.component, referrer.ref);
    else if (referrer.kind === 'mount') detachMount(root, referrer.domain, referrer.component);
    else detachAuth(root, referrer.domain, referrer.component);
  }

  fs.rmSync(component.path, { recursive: true, force: true });
  loadWorkspace(root);
  return referrers;
}

// Fusion-style controllers use decorators; plain-ts controllers use fields.
/** Couplings from OTHER modules into any component of moduleName. */
export function findModuleReferrers(model: WorkspaceModel, moduleName: string): Referrer[] {
  const domain = model.domains.find((candidate) => candidate.name === moduleName);
  if (!domain) return [];
  const referrers: Referrer[] = [];
  for (const component of [...domain.components, ...(domain.packComponents ?? [])]) {
    for (const referrer of findReferrers(model, moduleName, component.name)) {
      if (referrer.domain !== moduleName) referrers.push(referrer);
    }
  }
  return referrers;
}

/**
 * Removes a whole module (domain) and its files. Refuses while other modules
 * still couple to its components, unless force is set — then those couplings
 * are detached first, so no dangling reference survives.
 */
export function removeModule(root: string, moduleName: string, options: { force: boolean }): Referrer[] {
  const model = loadWorkspace(root);
  const domain = model.domains.find((candidate) => candidate.name === moduleName);
  if (!domain) {
    throw new ForgeError(
      `Module "${moduleName}" does not exist`,
      `Available modules: ${model.domains.map((d) => d.name).join(', ') || '(none)'}`,
    );
  }

  const referrers = findModuleReferrers(model, moduleName);
  if (referrers.length > 0 && !options.force) {
    const list = referrers
      .map((referrer) => `${referrer.domain}/${referrer.component} (${referrer.kind} "${referrer.ref}")`)
      .join(', ');
    throw new ForgeError(
      `Module "${moduleName}" is still used by: ${list}`,
      'Detach those couplings first (forge detach <component> …) or pass --force to remove them along with the module.',
    );
  }
  for (const referrer of referrers) {
    if (referrer.kind === 'binding') detachBinding(root, referrer.domain, referrer.component, referrer.ref);
    else if (referrer.kind === 'subscription') detachSubscription(root, referrer.domain, referrer.component, referrer.ref);
    else if (referrer.kind === 'mount') detachMount(root, referrer.domain, referrer.component);
    else detachAuth(root, referrer.domain, referrer.component);
  }

  fs.rmSync(domain.path, { recursive: true, force: true });
  loadWorkspace(root);
  return referrers;
}

const CONTROLLER_ROUTE = /@Controller\('([^']*)'\)/;
const METHOD_DECORATOR = /@(Get|Post|Put|Patch|Delete)\(\)/;
const PLAIN_METHOD = /readonly method = '(GET|POST|PUT|PATCH|DELETE)'/;
const PLAIN_ROUTE = /readonly route = '([^']*)'/;

/**
 * Removes an endpoint: its API Gateway route, controller, use case and test,
 * then regenerates the barrel. Rolls everything back if the workspace stops
 * validating.
 */
export function removeEndpoint(
  root: string,
  moduleName: string,
  apiName: string,
  endpointName: string,
): { method: string; route: string } {
  const componentDir = path.join(root, 'domains', moduleName, 'components', apiName);
  const manifestFile = path.join(componentDir, COMPONENT_MANIFEST);
  if (!fs.existsSync(manifestFile)) {
    throw new ForgeError(`Component "${moduleName}/${apiName}" does not exist`);
  }
  const files = endpointFiles(componentDir, endpointName);
  if (!fs.existsSync(files.controller)) {
    const controllersDir = path.dirname(files.controller);
    const existing = fs.existsSync(controllersDir)
      ? fs
          .readdirSync(controllersDir)
          .filter((file) => file.endsWith('.controller.ts'))
          .map((file) => file.slice(0, -'.controller.ts'.length))
          .join(', ')
      : '(none)';
    throw new ForgeError(
      `Endpoint "${endpointName}" does not exist on "${moduleName}/${apiName}"`,
      `Existing endpoints: ${existing}.`,
    );
  }

  const source = fs.readFileSync(files.controller, 'utf8');
  let route: string | undefined;
  let method: string | undefined;
  const fusionRoute = CONTROLLER_ROUTE.exec(source);
  const fusionMethod = METHOD_DECORATOR.exec(source);
  if (fusionRoute && fusionMethod) {
    route = fusionRoute[1];
    method = fusionMethod[1].toUpperCase();
  } else {
    const plainMethod = PLAIN_METHOD.exec(source);
    const plainRoute = PLAIN_ROUTE.exec(source);
    if (plainMethod && plainRoute) {
      method = plainMethod[1];
      route = plainRoute[1];
    }
  }
  if (!route || !method) {
    throw new ForgeError(
      `Controller "${endpointName}.controller.ts" is not a forge-generated endpoint`,
      'Remove its route from component.json and delete the files by hand, then rerun any forge generate command to refresh the barrel.',
    );
  }

  const manifestBefore = fs.readFileSync(manifestFile, 'utf8');
  const manifest = JSON.parse(manifestBefore) as Record<string, any>;
  const routes: { method: string; path: string }[] = manifest.config?.routes ?? [];
  const nextRoutes = routes.filter((entry) => !(entry.method === method && entry.path === route));
  if (routes.length > 0 && nextRoutes.length === 0) {
    throw new ForgeError(
      `"${endpointName}" is the last endpoint of "${moduleName}/${apiName}" — an http-api needs at least one route`,
      `Remove the whole component instead: forge remove component ${apiName} --module ${moduleName}.`,
    );
  }

  const backups = new Map<string, string>();
  for (const file of Object.values(files)) {
    if (fs.existsSync(file)) backups.set(file, fs.readFileSync(file, 'utf8'));
  }

  manifest.config = { ...(manifest.config ?? {}), routes: nextRoutes };
  writeJson(manifestFile, manifest);
  for (const file of backups.keys()) fs.rmSync(file, { force: true });
  regenerateControllersBarrel(componentDir);

  try {
    loadWorkspace(root);
  } catch (error) {
    fs.writeFileSync(manifestFile, manifestBefore);
    for (const [file, content] of backups) fs.writeFileSync(file, content);
    regenerateControllersBarrel(componentDir);
    throw error;
  }
  return { method, route };
}
