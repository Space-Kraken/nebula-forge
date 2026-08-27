import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadWorkspace } from '../src';

const createdDirs: string[] = [];

function makeWorkspace(files: Record<string, unknown>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-core-test-'));
  createdDirs.push(root);
  for (const [relative, content] of Object.entries(files)) {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(content, null, 2));
  }
  return root;
}

afterEach(() => {
  for (const dir of createdDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const baseManifest = {
  name: 'shop',
  engine: 'aws-cdk',
  defaultEnvironment: 'dev',
  environments: { dev: { region: 'us-east-1' } },
};

describe('loadWorkspace', () => {
  it('loads domains and applies config defaults', () => {
    const root = makeWorkspace({
      'forge.json': baseManifest,
      'domains/billing/domain.json': { name: 'billing' },
      'domains/billing/components/api/component.json': {
        name: 'api',
        type: 'http-api',
        bindings: [{ component: 'data', access: 'read-write' }],
      },
      'domains/billing/components/data/component.json': {
        name: 'data',
        type: 'table',
        config: { partitionKey: { name: 'id' } },
      },
    });

    const model = loadWorkspace(root);
    expect(model.name).toBe('shop');
    expect(model.domains).toHaveLength(1);
    expect(model.domains[0].components).toHaveLength(2);

    const api = model.domains[0].components.find((component) => component.name === 'api');
    if (api?.type !== 'http-api') throw new Error('expected http-api component');
    expect(api.config.memoryMb).toBe(256);
    expect(api.config.entry).toBe('src/handler.ts');
    expect(api.config.routes).toEqual([{ method: 'ANY', path: '/{proxy+}' }]);
  });

  it('finds the workspace root from a nested directory', () => {
    const root = makeWorkspace({ 'forge.json': baseManifest });
    const nested = path.join(root, 'domains', 'billing', 'components');
    fs.mkdirSync(nested, { recursive: true });
    expect(loadWorkspace(nested).root).toBe(root);
  });

  it('rejects bindings to unknown components', () => {
    const root = makeWorkspace({
      'forge.json': baseManifest,
      'domains/billing/domain.json': { name: 'billing' },
      'domains/billing/components/api/component.json': {
        name: 'api',
        type: 'http-api',
        bindings: [{ component: 'missing', access: 'read' }],
      },
    });
    expect(() => loadWorkspace(root)).toThrow(/unknown component "missing"/);
  });

  it('rejects unsupported binding access modes', () => {
    const root = makeWorkspace({
      'forge.json': baseManifest,
      'domains/billing/domain.json': { name: 'billing' },
      'domains/billing/components/api/component.json': {
        name: 'api',
        type: 'http-api',
        bindings: [{ component: 'data', access: 'publish' }],
      },
      'domains/billing/components/data/component.json': {
        name: 'data',
        type: 'table',
        config: { partitionKey: { name: 'id' } },
      },
    });
    expect(() => loadWorkspace(root)).toThrow(/does not support "publish"/);
  });

  it('allows cross-domain bindings and subscriptions to event buses only', () => {
    const root = makeWorkspace({
      'forge.json': baseManifest,
      'domains/platform/domain.json': { name: 'platform' },
      'domains/platform/components/events/component.json': { name: 'events', type: 'event-bus' },
      'domains/billing/domain.json': { name: 'billing' },
      'domains/billing/components/api/component.json': {
        name: 'api',
        type: 'http-api',
        bindings: [{ component: 'platform/events', access: 'publish' }],
      },
      'domains/billing/components/worker/component.json': {
        name: 'worker',
        type: 'queue-worker',
        config: { subscriptions: [{ bus: 'platform/events', pattern: { source: ['billing'] } }] },
      },
    });
    expect(() => loadWorkspace(root)).not.toThrow();
  });

  it('rejects cross-domain bindings to anything that is not an event bus', () => {
    const root = makeWorkspace({
      'forge.json': baseManifest,
      'domains/platform/domain.json': { name: 'platform' },
      'domains/platform/components/data/component.json': {
        name: 'data',
        type: 'table',
        config: { partitionKey: { name: 'id' } },
      },
      'domains/billing/domain.json': { name: 'billing' },
      'domains/billing/components/api/component.json': {
        name: 'api',
        type: 'http-api',
        bindings: [{ component: 'platform/data', access: 'read' }],
      },
    });
    expect(() => loadWorkspace(root)).toThrow(/binds across domains/);
  });

  it('allows function components to subscribe to event buses', () => {
    const root = makeWorkspace({
      'forge.json': baseManifest,
      'domains/billing/domain.json': { name: 'billing' },
      'domains/billing/components/events/component.json': { name: 'events', type: 'event-bus' },
      'domains/billing/components/notifier/component.json': {
        name: 'notifier',
        type: 'function',
        config: { subscriptions: [{ bus: 'events', pattern: { detailType: ['OrderPlaced'] } }] },
      },
    });
    expect(() => loadWorkspace(root)).not.toThrow();
  });

  it('rejects function subscriptions to unknown buses', () => {
    const root = makeWorkspace({
      'forge.json': baseManifest,
      'domains/billing/domain.json': { name: 'billing' },
      'domains/billing/components/notifier/component.json': {
        name: 'notifier',
        type: 'function',
        config: { subscriptions: [{ bus: 'missing', pattern: { source: ['x'] } }] },
      },
    });
    expect(() => loadWorkspace(root)).toThrow(/unknown bus "missing"/);
  });

  it('rejects subscriptions to components that are not event buses', () => {
    const root = makeWorkspace({
      'forge.json': baseManifest,
      'domains/billing/domain.json': { name: 'billing' },
      'domains/billing/components/notices/component.json': { name: 'notices', type: 'topic' },
      'domains/billing/components/worker/component.json': {
        name: 'worker',
        type: 'queue-worker',
        config: { subscriptions: [{ bus: 'notices', pattern: { source: ['x'] } }] },
      },
    });
    expect(() => loadWorkspace(root)).toThrow(/not an event-bus/);
  });

  it('rejects FIFO queue-workers with event-bus subscriptions', () => {
    const root = makeWorkspace({
      'forge.json': baseManifest,
      'domains/platform/domain.json': { name: 'platform' },
      'domains/platform/components/events/component.json': { name: 'events', type: 'event-bus' },
      'domains/billing/domain.json': { name: 'billing' },
      'domains/billing/components/worker/component.json': {
        name: 'worker',
        type: 'queue-worker',
        config: { fifo: true, subscriptions: [{ bus: 'platform/events', pattern: { source: ['x'] } }] },
      },
    });
    expect(() => loadWorkspace(root)).toThrow(/FIFO queue-worker with event-bus subscriptions/);
  });

  it('rejects physical resource name collisions across domains', () => {
    const root = makeWorkspace({
      'forge.json': baseManifest,
      'domains/pay/domain.json': { name: 'pay' },
      'domains/pay/components/ments-x/component.json': { name: 'ments-x', type: 'event-bus' },
      'domains/pay-ments/domain.json': { name: 'pay-ments' },
      'domains/pay-ments/components/x/component.json': { name: 'x', type: 'event-bus' },
    });
    expect(() => loadWorkspace(root)).toThrow(/share the physical resource name/);
  });

  it('rejects duplicate bindings to the same target', () => {
    const root = makeWorkspace({
      'forge.json': baseManifest,
      'domains/billing/domain.json': { name: 'billing' },
      'domains/billing/components/data/component.json': {
        name: 'data',
        type: 'table',
        config: { partitionKey: { name: 'id' } },
      },
      'domains/billing/components/api/component.json': {
        name: 'api',
        type: 'http-api',
        bindings: [
          { component: 'data', access: 'read' },
          { component: 'data', access: 'write' },
        ],
      },
    });
    expect(() => loadWorkspace(root)).toThrow(/multiple bindings to "billing\/data"/);
  });

  it('rejects malformed API routes', () => {
    for (const path of ['/x/{id', '/x/id}', '/x/a{id}b', '/p/{proxy+}/tail', 'no-slash']) {
      const root = makeWorkspace({
        'forge.json': baseManifest,
        'domains/billing/domain.json': { name: 'billing' },
        'domains/billing/components/api/component.json': {
          name: 'api',
          type: 'http-api',
          config: { routes: [{ method: 'GET', path }] },
        },
      });
      expect(() => loadWorkspace(root), `route: ${path}`).toThrow();
    }
  });

  it('rejects sibling path variables with different names', () => {
    const root = makeWorkspace({
      'forge.json': baseManifest,
      'domains/billing/domain.json': { name: 'billing' },
      'domains/billing/components/api/component.json': {
        name: 'api',
        type: 'http-api',
        config: {
          routes: [
            { method: 'GET', path: '/orders/{id}' },
            { method: 'PUT', path: '/orders/{orderId}' },
          ],
        },
      },
    });
    expect(() => loadWorkspace(root)).toThrow(/sibling path variables/);
  });

  it('rejects duplicate identical subscriptions', () => {
    const root = makeWorkspace({
      'forge.json': baseManifest,
      'domains/billing/domain.json': { name: 'billing' },
      'domains/billing/components/events/component.json': { name: 'events', type: 'event-bus' },
      'domains/billing/components/worker/component.json': {
        name: 'worker',
        type: 'queue-worker',
        config: {
          subscriptions: [
            { bus: 'events', pattern: { source: ['x'] } },
            { bus: 'events', pattern: { source: ['x'] } },
          ],
        },
      },
    });
    expect(() => loadWorkspace(root)).toThrow(/same subscription .* twice/);
  });

  it('rejects unknown manifest keys instead of silently stripping them', () => {
    const root = makeWorkspace({
      'forge.json': baseManifest,
      'domains/billing/domain.json': { name: 'billing' },
      'domains/billing/components/data/component.json': {
        name: 'data',
        type: 'table',
        config: { partitionKey: { name: 'id' }, subscriptions: [{ bus: 'x', pattern: { source: ['y'] } }] },
      },
    });
    expect(() => loadWorkspace(root)).toThrow(/Unrecognized key/i);
  });

  it('allows http-apis to mount a cross-domain gateway', () => {
    const root = makeWorkspace({
      'forge.json': baseManifest,
      'domains/platform/domain.json': { name: 'platform' },
      'domains/platform/components/edge/component.json': { name: 'edge', type: 'gateway' },
      'domains/users/domain.json': { name: 'users' },
      'domains/users/components/api/component.json': {
        name: 'api',
        type: 'http-api',
        config: { mount: 'platform/edge', routes: [{ method: 'GET', path: '/users/{id}' }] },
      },
    });
    expect(() => loadWorkspace(root)).not.toThrow();
  });

  it('rejects mounts to components that are not gateways', () => {
    const root = makeWorkspace({
      'forge.json': baseManifest,
      'domains/users/domain.json': { name: 'users' },
      'domains/users/components/data/component.json': {
        name: 'data',
        type: 'table',
        config: { partitionKey: { name: 'id' } },
      },
      'domains/users/components/api/component.json': {
        name: 'api',
        type: 'http-api',
        config: { mount: 'data' },
      },
    });
    expect(() => loadWorkspace(root)).toThrow(/not a gateway/);
  });

  it('rejects route conflicts across http-apis mounted on the same gateway', () => {
    const root = makeWorkspace({
      'forge.json': baseManifest,
      'domains/platform/domain.json': { name: 'platform' },
      'domains/platform/components/edge/component.json': { name: 'edge', type: 'gateway' },
      'domains/users/domain.json': { name: 'users' },
      'domains/users/components/api/component.json': {
        name: 'api',
        type: 'http-api',
        config: { mount: 'platform/edge', routes: [{ method: 'GET', path: '/things' }] },
      },
      'domains/orders/domain.json': { name: 'orders' },
      'domains/orders/components/api/component.json': {
        name: 'api',
        type: 'http-api',
        config: { mount: 'platform/edge', routes: [{ method: 'GET', path: '/things' }] },
      },
    });
    expect(() => loadWorkspace(root)).toThrow(
      /Route GET \/things is declared by both "(orders|users)\/api" and "(orders|users)\/api" on gateway "platform\/edge"/,
    );
  });

  it('rejects sibling path variables across http-apis on the same gateway', () => {
    const root = makeWorkspace({
      'forge.json': baseManifest,
      'domains/platform/domain.json': { name: 'platform' },
      'domains/platform/components/edge/component.json': { name: 'edge', type: 'gateway' },
      'domains/users/domain.json': { name: 'users' },
      'domains/users/components/api/component.json': {
        name: 'api',
        type: 'http-api',
        config: { mount: 'platform/edge', routes: [{ method: 'GET', path: '/items/{id}' }] },
      },
      'domains/orders/domain.json': { name: 'orders' },
      'domains/orders/components/api/component.json': {
        name: 'api',
        type: 'http-api',
        config: { mount: 'platform/edge', routes: [{ method: 'PUT', path: '/items/{itemId}' }] },
      },
    });
    expect(() => loadWorkspace(root)).toThrow(/sibling path variables/);
  });

  it('validates auth attachments: same module, auth type, not on mounted apis', () => {
    const base = {
      'forge.json': baseManifest,
      'domains/platform/domain.json': { name: 'platform' },
      'domains/platform/components/identity/component.json': { name: 'identity', type: 'auth' },
      'domains/platform/components/edge/component.json': {
        name: 'edge',
        type: 'gateway',
        config: { auth: 'identity' },
      },
    };
    expect(() => loadWorkspace(makeWorkspace(base))).not.toThrow();

    expect(() =>
      loadWorkspace(
        makeWorkspace({
          ...base,
          'domains/platform/components/edge/component.json': {
            name: 'edge',
            type: 'gateway',
            config: { auth: 'missing' },
          },
        }),
      ),
    ).toThrow(/unknown auth component "missing"/);

    expect(() =>
      loadWorkspace(
        makeWorkspace({
          ...base,
          'domains/users/domain.json': { name: 'users' },
          'domains/users/components/api/component.json': {
            name: 'api',
            type: 'http-api',
            config: { mount: 'platform/edge', auth: 'identity', routes: [{ method: 'GET', path: '/users' }] },
          },
        }),
      ),
    ).toThrow(/mounted on a gateway but declares its own auth/);
  });

  it('validates email components and their send bindings', () => {
    const valid = makeWorkspace({
      'forge.json': baseManifest,
      'domains/billing/domain.json': { name: 'billing' },
      'domains/billing/components/notifications/component.json': {
        name: 'notifications',
        type: 'email',
        config: { identity: 'no-reply@app.com' },
      },
      'domains/billing/components/mailer/component.json': {
        name: 'mailer',
        type: 'function',
        bindings: [{ component: 'notifications', access: 'send' }],
      },
    });
    expect(() => loadWorkspace(valid)).not.toThrow();

    expect(() =>
      loadWorkspace(
        makeWorkspace({
          'forge.json': baseManifest,
          'domains/billing/domain.json': { name: 'billing' },
          'domains/billing/components/notifications/component.json': {
            name: 'notifications',
            type: 'email',
            config: { identity: 'not-an-identity' },
          },
        }),
      ),
    ).toThrow(/must be an email address/);

    expect(() =>
      loadWorkspace(
        makeWorkspace({
          'forge.json': baseManifest,
          'domains/billing/domain.json': { name: 'billing' },
          'domains/billing/components/notifications/component.json': {
            name: 'notifications',
            type: 'email',
            config: { identity: 'app.com' },
          },
          'domains/billing/components/mailer/component.json': {
            name: 'mailer',
            type: 'function',
            bindings: [{ component: 'notifications', access: 'read' }],
          },
        }),
      ),
    ).toThrow(/does not support "read" bindings \(allowed: send\)/);
  });

  it('fails with a helpful error outside a workspace', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-core-empty-'));
    createdDirs.push(root);
    expect(() => loadWorkspace(root)).toThrow(/No forge\.json found/);
  });
});
