import * as fs from 'node:fs';
import * as path from 'node:path';
import { bindingAccessSchema, COMPONENT_MANIFEST, ForgeError, loadWorkspace } from '@forgecli/core';
import type { Binding } from '@forgecli/core';

export interface Subscription {
  bus: string;
  pattern: { source?: string[]; detailType?: string[] };
}

function componentManifestPath(root: string, moduleName: string, componentName: string): string {
  const file = path.join(root, 'domains', moduleName, 'components', componentName, COMPONENT_MANIFEST);
  if (!fs.existsSync(file)) {
    throw new ForgeError(`Component "${moduleName}/${componentName}" does not exist`);
  }
  return file;
}

/**
 * Edits an existing manifest, re-validates the whole workspace and rolls the
 * file back if the edit makes the model invalid.
 */
function editManifest(
  root: string,
  file: string,
  edit: (manifest: Record<string, any>) => boolean,
): boolean {
  const before = fs.readFileSync(file, 'utf8');
  const manifest = JSON.parse(before) as Record<string, any>;
  if (!edit(manifest)) return false;
  fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
  try {
    loadWorkspace(root);
  } catch (error) {
    fs.writeFileSync(file, before);
    throw error;
  }
  return true;
}

/**
 * Attaches a binding to an existing consumer component ("who will use the new
 * resource"). Returns false when an identical target is already bound.
 */
export function attachBinding(
  root: string,
  moduleName: string,
  consumerName: string,
  binding: Binding,
): boolean {
  const file = componentManifestPath(root, moduleName, consumerName);
  return editManifest(root, file, (manifest) => {
    const bindings: Binding[] = Array.isArray(manifest.bindings) ? manifest.bindings : [];
    if (bindings.some((existing) => existing.component === binding.component)) return false;
    manifest.bindings = [...bindings, binding];
    return true;
  });
}

const SUBSCRIBER_MANIFEST_TYPES = ['queue-worker', 'function'];

function subscriptionKey(subscription: { bus: string; pattern?: { source?: string[]; detailType?: string[] } }): string {
  return JSON.stringify([subscription.bus, subscription.pattern?.source ?? null, subscription.pattern?.detailType ?? null]);
}

/**
 * Attaches an EventBridge subscription to an existing queue-worker or
 * function. Returns false when an identical subscription already exists.
 */
export function attachSubscription(
  root: string,
  moduleName: string,
  componentName: string,
  subscription: Subscription,
): boolean {
  const file = componentManifestPath(root, moduleName, componentName);
  return editManifest(root, file, (manifest) => {
    if (!SUBSCRIBER_MANIFEST_TYPES.includes(manifest.type)) {
      throw new ForgeError(
        `Component "${moduleName}/${componentName}" is a ${manifest.type} and cannot subscribe to event buses`,
        'Only queue-worker and function components subscribe to buses.',
      );
    }
    manifest.config = manifest.config ?? {};
    const subscriptions: Subscription[] = Array.isArray(manifest.config.subscriptions)
      ? manifest.config.subscriptions
      : [];
    if (subscriptions.some((existing) => subscriptionKey(existing) === subscriptionKey(subscription))) return false;
    manifest.config.subscriptions = [...subscriptions, subscription];
    return true;
  });
}

/** Removes the binding to targetRef; returns false when it was not bound. */
export function detachBinding(root: string, moduleName: string, componentName: string, targetRef: string): boolean {
  const file = componentManifestPath(root, moduleName, componentName);
  return editManifest(root, file, (manifest) => {
    const bindings: Binding[] = Array.isArray(manifest.bindings) ? manifest.bindings : [];
    const next = bindings.filter((binding) => binding.component !== targetRef);
    if (next.length === bindings.length) return false;
    if (next.length > 0) manifest.bindings = next;
    else delete manifest.bindings;
    return true;
  });
}

/** Removes every subscription to busRef; returns false when none existed. */
export function detachSubscription(root: string, moduleName: string, componentName: string, busRef: string): boolean {
  const file = componentManifestPath(root, moduleName, componentName);
  return editManifest(root, file, (manifest) => {
    const subscriptions: Subscription[] = Array.isArray(manifest.config?.subscriptions)
      ? manifest.config.subscriptions
      : [];
    const next = subscriptions.filter((subscription) => subscription.bus !== busRef);
    if (next.length === subscriptions.length) return false;
    if (next.length > 0) manifest.config.subscriptions = next;
    else delete manifest.config.subscriptions;
    return true;
  });
}

/** Mounts an existing http-api on a shared gateway. Returns false when already mounted there. */
export function attachMount(root: string, moduleName: string, componentName: string, gatewayRef: string): boolean {
  const file = componentManifestPath(root, moduleName, componentName);
  return editManifest(root, file, (manifest) => {
    if (manifest.type !== 'http-api') {
      throw new ForgeError(
        `Component "${moduleName}/${componentName}" is a ${manifest.type}; only http-api components mount gateways`,
      );
    }
    manifest.config = manifest.config ?? {};
    if (manifest.config.mount === gatewayRef) return false;
    if (manifest.config.mount) {
      throw new ForgeError(
        `Component "${moduleName}/${componentName}" is already mounted on "${manifest.config.mount}"`,
        `Detach it first: forge detach ${componentName} --module ${moduleName} --mount`,
      );
    }
    manifest.config.mount = gatewayRef;
    return true;
  });
}

/** Unmounts an http-api (it goes back to provisioning its own gateway). */
export function detachMount(root: string, moduleName: string, componentName: string): boolean {
  const file = componentManifestPath(root, moduleName, componentName);
  return editManifest(root, file, (manifest) => {
    if (!manifest.config?.mount) return false;
    delete manifest.config.mount;
    return true;
  });
}

/** Parses repeated --attach flags of the form "<consumer>:<access>". */
export function parseAttaches(values: string[] | undefined): { consumer: string; access: Binding['access'] }[] {
  if (!values) return [];
  return values.map((value) => {
    const separator = value.lastIndexOf(':');
    if (separator <= 0 || separator === value.length - 1) {
      throw new ForgeError(
        `Invalid attach "${value}"`,
        'Use the form <consumer>:<access>, e.g. --attach api:read-write.',
      );
    }
    const access = bindingAccessSchema.safeParse(value.slice(separator + 1));
    if (!access.success) {
      throw new ForgeError(
        `Invalid access "${value.slice(separator + 1)}" in attach "${value}"`,
        `Allowed access modes: ${bindingAccessSchema.options.join(', ')}.`,
      );
    }
    return { consumer: value.slice(0, separator), access: access.data };
  });
}

/**
 * Parses repeated --subscribe flags:
 *   --subscribe platform/events:source=orders,payments
 *   --subscribe platform/events:detail-type=OrderPlaced
 *   --subscribe events:source=orders:detail-type=OrderPlaced
 */
export function parseSubscribes(values: string[] | undefined): Subscription[] {
  if (!values) return [];
  return values.map((value) => {
    const [bus, ...rest] = value.split(':');
    if (!bus) {
      throw new ForgeError(`Invalid subscription "${value}"`);
    }
    const pattern: Subscription['pattern'] = {};
    for (const segment of rest) {
      const equals = segment.indexOf('=');
      const key = equals === -1 ? segment : segment.slice(0, equals);
      const list = equals === -1 ? [] : segment.slice(equals + 1).split(',').filter(Boolean);
      if (key === 'source' && list.length > 0) pattern.source = list;
      else if (key === 'detail-type' && list.length > 0) pattern.detailType = list;
      else {
        throw new ForgeError(
          `Invalid subscription segment "${segment}" in "${value}"`,
          'Use --subscribe <bus>:source=a,b and/or :detail-type=X,Y.',
        );
      }
    }
    if (!pattern.source && !pattern.detailType) {
      throw new ForgeError(
        `Subscription "${value}" needs a pattern`,
        'Add :source=… and/or :detail-type=… so the rule matches specific events.',
      );
    }
    return { bus, pattern };
  });
}
