import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadWorkspace } from '@forgecli/core';
import { afterEach, describe, expect, it } from 'vitest';
import { attachBinding, attachSubscription, detachBinding, detachSubscription } from '../src/lib/attach';
import { addEndpoint } from '../src/lib/endpoints';
import { findReferrers, removeComponent, removeEndpoint } from '../src/lib/remove';
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
    expect(api.config.routes).toEqual([{ method: 'GET', path: '/status' }]);
  });

  it('refuses to remove the last endpoint and unknown endpoints', () => {
    const root = makeWorkspace();
    expect(() => removeEndpoint(root, 'orders', 'api', 'status')).toThrow(/last endpoint/);
    expect(() => removeEndpoint(root, 'orders', 'api', 'nope')).toThrow(/Endpoint "nope" does not exist/);
  });
});
