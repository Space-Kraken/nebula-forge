import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadWorkspace } from '@forgecli/core';
import { afterEach, describe, expect, it } from 'vitest';
import {
  attachBinding,
  attachMount,
  attachSubscription,
  detachBinding,
  detachMount,
  detachSubscription,
} from '../src/lib/attach';
import { addEndpoint } from '../src/lib/endpoints';
import { findReferrers, removeComponent, removeEndpoint, removeModule } from '../src/lib/remove';
import { scaffoldComponent, scaffoldModule, scaffoldWorkspace } from '../src/lib/scaffold';

const createdDirs: string[] = [];

function makeWorkspace(): string {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-remove-test-'));
  createdDirs.push(parent);
  const root = path.join(parent, 'shop');
  scaffoldWorkspace({ name: 'shop', targetDir: root, link: false });
  scaffoldModule(root, 'platform');
  scaffoldComponent(root, 'platform', { name: 'events', type: 'event-bus' });
  scaffoldModule(root, 'orders');
  scaffoldComponent(root, 'orders', { name: 'api', type: 'http-api' });
  scaffoldComponent(root, 'orders', {
    name: 'data',
    type: 'table',
    config: { partitionKey: { name: 'id' } },
  });
  attachBinding(root, 'orders', 'api', { component: 'data', access: 'read-write' });
  return root;
}

afterEach(() => {
  for (const dir of createdDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('attachSubscription / detach', () => {
  it('subscribes a worker, is idempotent, and detaches cleanly', () => {
    const root = makeWorkspace();
    scaffoldComponent(root, 'orders', { name: 'worker', type: 'queue-worker' });

    const subscription = { bus: 'platform/events', pattern: { source: ['orders'] } };
    expect(attachSubscription(root, 'orders', 'worker', subscription)).toBe(true);
    expect(attachSubscription(root, 'orders', 'worker', subscription)).toBe(false);
    expect(detachSubscription(root, 'orders', 'worker', 'platform/events')).toBe(true);
    expect(detachSubscription(root, 'orders', 'worker', 'platform/events')).toBe(false);
  });

  it('refuses to subscribe a non-subscriber component and writes nothing', () => {
    const root = makeWorkspace();
    const manifestFile = path.join(root, 'domains', 'orders', 'components', 'data', 'component.json');
    const before = fs.readFileSync(manifestFile, 'utf8');
    expect(() =>
      attachSubscription(root, 'orders', 'data', { bus: 'platform/events', pattern: { source: ['x'] } }),
    ).toThrow(/cannot subscribe/);
    expect(fs.readFileSync(manifestFile, 'utf8')).toBe(before);
  });

  it('detachBinding removes the binding and reports missing ones', () => {
    const root = makeWorkspace();
    expect(detachBinding(root, 'orders', 'api', 'data')).toBe(true);
    expect(detachBinding(root, 'orders', 'api', 'data')).toBe(false);
    const model = loadWorkspace(root);
    const api = model.domains.find((d) => d.name === 'orders')!.components.find((c) => c.name === 'api');
    expect(api?.bindings).toEqual([]);
  });
});

describe('gateway mounts', () => {
  it('mounts and unmounts an http-api on a cross-domain gateway', () => {
    const root = makeWorkspace();
    scaffoldComponent(root, 'platform', { name: 'edge', type: 'gateway' });

    expect(attachMount(root, 'orders', 'api', 'platform/edge')).toBe(true);
    expect(attachMount(root, 'orders', 'api', 'platform/edge')).toBe(false);
    const model = loadWorkspace(root);
    const api = model.domains.find((d) => d.name === 'orders')!.components.find((c) => c.name === 'api');
    if (api?.type !== 'http-api') throw new Error('expected http-api');
    expect(api.config.mount).toBe('platform/edge');

    expect(detachMount(root, 'orders', 'api')).toBe(true);
    expect(detachMount(root, 'orders', 'api')).toBe(false);
  });

  it('refuses to mount non-http-api components and remounts require detach', () => {
    const root = makeWorkspace();
    scaffoldComponent(root, 'platform', { name: 'edge', type: 'gateway' });
    scaffoldComponent(root, 'platform', { name: 'edge2', type: 'gateway' });
    expect(() => attachMount(root, 'orders', 'data', 'platform/edge')).toThrow(/only http-api components mount/);
    attachMount(root, 'orders', 'api', 'platform/edge');
    expect(() => attachMount(root, 'orders', 'api', 'platform/edge2')).toThrow(/already mounted/);
  });

  it('removeComponent on a gateway refuses while mounted, and --force unmounts', () => {
    const root = makeWorkspace();
    scaffoldComponent(root, 'platform', { name: 'edge', type: 'gateway' });
    attachMount(root, 'orders', 'api', 'platform/edge');

    expect(() => removeComponent(root, 'platform', 'edge', { force: false })).toThrow(
      /still used by: orders\/api \(mount "platform\/edge"\)/,
    );
    const detached = removeComponent(root, 'platform', 'edge', { force: true });
    expect(detached).toEqual([{ domain: 'orders', component: 'api', ref: 'platform/edge', kind: 'mount' }]);

    const model = loadWorkspace(root);
    const api = model.domains.find((d) => d.name === 'orders')!.components.find((c) => c.name === 'api');
    if (api?.type !== 'http-api') throw new Error('expected http-api');
    expect(api.config.mount).toBeUndefined();
  });
});

describe('auth attachments', () => {
  it('protects and unprotects a gateway, and remove treats auth as referrer', async () => {
    const { attachAuth, detachAuth } = await import('../src/lib/attach');
    const root = makeWorkspace();
    scaffoldComponent(root, 'platform', { name: 'edge', type: 'gateway' });
    scaffoldComponent(root, 'platform', { name: 'identity', type: 'auth' });

    expect(attachAuth(root, 'platform', 'edge', 'identity')).toBe(true);
    expect(attachAuth(root, 'platform', 'edge', 'identity')).toBe(false);
    expect(() => attachAuth(root, 'orders', 'data', 'identity')).toThrow(/auth attaches to gateways/);

    expect(() => removeComponent(root, 'platform', 'identity', { force: false })).toThrow(
      /still used by: platform\/edge \(auth "identity"\)/,
    );
    const detached = removeComponent(root, 'platform', 'identity', { force: true });
    expect(detached).toEqual([{ domain: 'platform', component: 'edge', ref: 'identity', kind: 'auth' }]);

    scaffoldComponent(root, 'platform', { name: 'identity', type: 'auth' });
    attachAuth(root, 'platform', 'edge', 'identity');
    expect(detachAuth(root, 'platform', 'edge')).toBe(true);
    expect(detachAuth(root, 'platform', 'edge')).toBe(false);
  });
});

describe('removeComponent', () => {
  it('refuses while referrers exist and lists them', () => {
    const root = makeWorkspace();
    expect(() => removeComponent(root, 'orders', 'data', { force: false })).toThrow(
      /still used by: orders\/api \(binding "data"\)/,
    );
  });

  it('with force detaches referrers (cross-domain included) and deletes the component', () => {
    const root = makeWorkspace();
    scaffoldComponent(root, 'orders', {
      name: 'worker',
      type: 'queue-worker',
      config: { subscriptions: [{ bus: 'platform/events', pattern: { source: ['orders'] } }] },
    });
    attachBinding(root, 'orders', 'api', { component: 'platform/events', access: 'publish' });

    const model = loadWorkspace(root);
    expect(findReferrers(model, 'platform', 'events')).toHaveLength(2);

    const detached = removeComponent(root, 'platform', 'events', { force: true });
    expect(detached).toHaveLength(2);
    expect(fs.existsSync(path.join(root, 'domains', 'platform', 'components', 'events'))).toBe(false);

    const after = loadWorkspace(root);
    const api = after.domains.find((d) => d.name === 'orders')!.components.find((c) => c.name === 'api');
    expect(api?.bindings).toEqual([{ component: 'data', access: 'read-write' }]);
  });
});

describe('removeModule', () => {
  it('refuses while other modules couple to it, and --force detaches everything', () => {
    const root = makeWorkspace();
    attachBinding(root, 'orders', 'api', { component: 'platform/events', access: 'publish' });

    expect(() => removeModule(root, 'platform', { force: false })).toThrow(
      /Module "platform" is still used by: orders\/api \(binding "platform\/events"\)/,
    );
    const detached = removeModule(root, 'platform', { force: true });
    expect(detached).toHaveLength(1);
    expect(fs.existsSync(path.join(root, 'domains', 'platform'))).toBe(false);

    const model = loadWorkspace(root);
    expect(model.domains.map((d) => d.name)).toEqual(['orders']);
    const api = model.domains[0].components.find((c) => c.name === 'api');
    expect(api?.bindings).toEqual([{ component: 'data', access: 'read-write' }]);
  });

  it('removes an unreferenced module outright', () => {
    const root = makeWorkspace();
    scaffoldModule(root, 'reporting');
    expect(removeModule(root, 'reporting', { force: false })).toEqual([]);
    expect(fs.existsSync(path.join(root, 'domains', 'reporting'))).toBe(false);
  });
});

describe('removeEndpoint', () => {
  it('removes route, files and barrel entry', () => {
    const root = makeWorkspace();
    addEndpoint(root, 'orders', 'api', { name: 'get-order', method: 'GET', route: '/orders/{id}' });

    const removed = removeEndpoint(root, 'orders', 'api', 'get-order');
    expect(removed).toEqual({ method: 'GET', route: '/orders/{id}' });

    const apiDir = path.join(root, 'domains', 'orders', 'components', 'api');
    expect(fs.existsSync(path.join(apiDir, 'src', 'infrastructure', 'controllers', 'get-order.controller.ts'))).toBe(false);
    expect(fs.existsSync(path.join(apiDir, 'src', 'application', 'get-order.uc.ts'))).toBe(false);
    const barrel = fs.readFileSync(path.join(apiDir, 'src', 'infrastructure', 'controllers', 'index.ts'), 'utf8');
    expect(barrel).not.toContain('GetOrderController');

    const model = loadWorkspace(root);
    const api = model.domains.find((d) => d.name === 'orders')!.components.find((c) => c.name === 'api');
    if (api?.type !== 'http-api') throw new Error('expected http-api');
    expect(api.config.routes).toEqual([{ method: 'GET', path: '/status', public: true }]);
  });

  it('refuses to remove the last endpoint and unknown endpoints', () => {
    const root = makeWorkspace();
    expect(() => removeEndpoint(root, 'orders', 'api', 'status')).toThrow(/last endpoint/);
    expect(() => removeEndpoint(root, 'orders', 'api', 'nope')).toThrow(/Endpoint "nope" does not exist/);
  });
});
