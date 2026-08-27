import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadWorkspace } from '@forgecli/core';
import { afterEach, describe, expect, it } from 'vitest';
import { attachBinding, parseAttaches, parseSubscribes } from '../src/lib/attach';
import { addEndpoint } from '../src/lib/endpoints';
import { scaffoldComponent, scaffoldModule, scaffoldWorkspace } from '../src/lib/scaffold';

const createdDirs: string[] = [];

function makeWorkspace(): string {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-cli-test-'));
  createdDirs.push(parent);
  const root = path.join(parent, 'shop');
  scaffoldWorkspace({ name: 'shop', targetDir: root, link: false });
  scaffoldModule(root, 'orders');
  scaffoldComponent(root, 'orders', { name: 'api', type: 'http-api' });
  scaffoldComponent(root, 'orders', {
    name: 'data',
    type: 'table',
    config: { partitionKey: { name: 'id' } },
  });
  return root;
}

afterEach(() => {
  for (const dir of createdDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('http-api scaffolding', () => {
  it('creates the status endpoint through the barrel', () => {
    const root = makeWorkspace();
    const apiDir = path.join(root, 'domains', 'orders', 'components', 'api');

    const barrel = fs.readFileSync(path.join(apiDir, 'src', 'infrastructure', 'controllers', 'index.ts'), 'utf8');
    expect(barrel).toContain("import { StatusController } from './status.controller';");
    expect(barrel).toContain('export const controllers = [');
    expect(fs.existsSync(path.join(apiDir, 'src', 'application', 'status.uc.ts'))).toBe(true);
    expect(fs.existsSync(path.join(apiDir, 'test', 'status.test.ts'))).toBe(true);

    const model = loadWorkspace(root);
    const api = model.domains[0].components.find((component) => component.name === 'api');
    if (api?.type !== 'http-api') throw new Error('expected http-api');
    expect(api.config.routes).toEqual([{ method: 'GET', path: '/status' }]);
  });
});

describe('addEndpoint', () => {
  it('adds the route, the endpoint files and regenerates the barrel', () => {
    const root = makeWorkspace();
    addEndpoint(root, 'orders', 'api', { name: 'get-order', method: 'GET', route: '/orders/{id}' });

    const apiDir = path.join(root, 'domains', 'orders', 'components', 'api');
    const barrel = fs.readFileSync(path.join(apiDir, 'src', 'infrastructure', 'controllers', 'index.ts'), 'utf8');
    expect(barrel).toContain("import { GetOrderController } from './get-order.controller';");
    expect(barrel).toContain('GetOrderController,');
    expect(barrel).toContain('StatusController,');

    const controller = fs.readFileSync(
      path.join(apiDir, 'src', 'infrastructure', 'controllers', 'get-order.controller.ts'),
      'utf8',
    );
    expect(controller).toContain("@Controller('/orders/{id}')");
    expect(controller).toContain('@Get()');

    const model = loadWorkspace(root);
    const api = model.domains[0].components.find((component) => component.name === 'api');
    if (api?.type !== 'http-api') throw new Error('expected http-api');
    expect(api.config.routes).toContainEqual({ method: 'GET', path: '/orders/{id}' });
  });

  it('rejects duplicate routes and invalid routes', () => {
    const root = makeWorkspace();
    expect(() => addEndpoint(root, 'orders', 'api', { name: 'st', method: 'GET', route: '/status' })).toThrow(
      /already exists/,
    );
    for (const route of ['no-slash', '/x/{id', '/x/id}', '/x/a{id}b', '/p/{proxy+}/tail']) {
      expect(() => addEndpoint(root, 'orders', 'api', { name: 'bad', method: 'GET', route }), route).toThrow(
        /Invalid route/,
      );
    }
  });

  it('rolls back completely when the new route conflicts with a sibling variable', () => {
    const root = makeWorkspace();
    addEndpoint(root, 'orders', 'api', { name: 'get-order', method: 'GET', route: '/orders/{id}' });
    const apiDir = path.join(root, 'domains', 'orders', 'components', 'api');
    expect(() =>
      addEndpoint(root, 'orders', 'api', { name: 'update-order', method: 'PUT', route: '/orders/{orderId}' }),
    ).toThrow(/sibling path variables/);

    // manifest, files and barrel all restored
    const model = loadWorkspace(root);
    const api = model.domains[0].components.find((component) => component.name === 'api');
    if (api?.type !== 'http-api') throw new Error('expected http-api');
    expect(api.config.routes).not.toContainEqual({ method: 'PUT', path: '/orders/{orderId}' });
    expect(fs.existsSync(path.join(apiDir, 'src', 'infrastructure', 'controllers', 'update-order.controller.ts'))).toBe(false);
    const barrel = fs.readFileSync(path.join(apiDir, 'src', 'infrastructure', 'controllers', 'index.ts'), 'utf8');
    expect(barrel).not.toContain('UpdateOrderController');
  });

  it('preserves the implicit default route set when the manifest omits routes', () => {
    const root = makeWorkspace();
    const manifestFile = path.join(root, 'domains', 'orders', 'components', 'api', 'component.json');
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    delete manifest.config.routes; // hand-maintained manifest relying on the schema default
    fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));

    addEndpoint(root, 'orders', 'api', { name: 'get-order', method: 'GET', route: '/orders/{id}' });
    const model = loadWorkspace(root);
    const api = model.domains[0].components.find((component) => component.name === 'api');
    if (api?.type !== 'http-api') throw new Error('expected http-api');
    // the previously implicit ANY /{proxy+} became explicit instead of vanishing
    expect(api.config.routes).toContainEqual({ method: 'ANY', path: '/{proxy+}' });
    expect(api.config.routes).toContainEqual({ method: 'GET', path: '/orders/{id}' });
  });

  it('refuses to build the barrel over files that break the naming convention', () => {
    const root = makeWorkspace();
    const controllersDir = path.join(root, 'domains', 'orders', 'components', 'api', 'src', 'infrastructure', 'controllers');
    fs.writeFileSync(path.join(controllersDir, 'orders.admin.controller.ts'), 'export class Whatever {}\n');
    expect(() =>
      addEndpoint(root, 'orders', 'api', { name: 'list-orders', method: 'GET', route: '/orders' }),
    ).toThrow(/naming convention/);
  });
});

describe('attachBinding', () => {
  it('adds the binding to the consumer manifest and is idempotent', () => {
    const root = makeWorkspace();
    expect(attachBinding(root, 'orders', 'api', { component: 'data', access: 'read-write' })).toBe(true);
    expect(attachBinding(root, 'orders', 'api', { component: 'data', access: 'read-write' })).toBe(false);

    const model = loadWorkspace(root);
    const api = model.domains[0].components.find((component) => component.name === 'api');
    expect(api?.bindings).toEqual([{ component: 'data', access: 'read-write' }]);
  });

  it('rolls the manifest back when the binding is invalid', () => {
    const root = makeWorkspace();
    const manifestFile = path.join(root, 'domains', 'orders', 'components', 'api', 'component.json');
    const before = fs.readFileSync(manifestFile, 'utf8');
    expect(() => attachBinding(root, 'orders', 'api', { component: 'data', access: 'publish' })).toThrow(
      /does not support "publish"/,
    );
    expect(fs.readFileSync(manifestFile, 'utf8')).toBe(before);
  });
});

describe('runtime ts (plain hexagonal, no fusion)', () => {
  it('scaffolds an http-api with the forge router instead of fusion', () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-runtime-test-'));
    createdDirs.push(parent);
    const root = path.join(parent, 'shop');
    scaffoldWorkspace({ name: 'shop', targetDir: root, link: false });
    scaffoldModule(root, 'users');
    scaffoldComponent(root, 'users', { name: 'api', type: 'http-api', config: { runtime: 'ts' } });

    const apiDir = path.join(root, 'domains', 'users', 'components', 'api');
    const handler = fs.readFileSync(path.join(apiDir, 'src', 'handler.ts'), 'utf8');
    expect(handler).toContain('No route for');
    expect(handler).not.toContain('@fusion-framework');

    const controller = fs.readFileSync(
      path.join(apiDir, 'src', 'infrastructure', 'controllers', 'status.controller.ts'),
      'utf8',
    );
    expect(controller).toContain("readonly method = 'GET'");
    expect(controller).toContain("readonly route = '/status'");
    expect(controller).not.toContain('@Controller');

    // endpoints on a ts api generate plain controllers, and removal parses them
    addEndpoint(root, 'users', 'api', { name: 'get-user', method: 'GET', route: '/users/{id}' });
    const generated = fs.readFileSync(
      path.join(apiDir, 'src', 'infrastructure', 'controllers', 'get-user.controller.ts'),
      'utf8',
    );
    expect(generated).toContain("readonly route = '/users/{id}'");
    expect(loadWorkspace(root)).toBeTruthy();
  });

  it('honors the workspace default runtime from forge.json', () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-runtime-default-'));
    createdDirs.push(parent);
    const root = path.join(parent, 'shop');
    scaffoldWorkspace({ name: 'shop', targetDir: root, link: false });
    const manifestFile = path.join(root, 'forge.json');
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    manifest.defaults = { runtime: 'ts' };
    fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));

    scaffoldModule(root, 'users');
    scaffoldComponent(root, 'users', { name: 'api', type: 'http-api' });
    const handler = fs.readFileSync(
      path.join(root, 'domains', 'users', 'components', 'api', 'src', 'handler.ts'),
      'utf8',
    );
    expect(handler).not.toContain('@fusion-framework');
  });
});

describe('writeEnvironmentState', () => {
  it('persists the backend into forge.json and validates', async () => {
    const { writeEnvironmentState } = await import('../src/lib/state');
    const root = makeWorkspace();
    writeEnvironmentState(root, 'dev', {
      resourceGroup: 'rg-shop-tfstate-dev',
      storageAccount: 'stshopdevabc123',
      container: 'tfstate',
    });
    const model = loadWorkspace(root);
    expect(model.environments.dev.state).toEqual({
      resourceGroup: 'rg-shop-tfstate-dev',
      storageAccount: 'stshopdevabc123',
      container: 'tfstate',
    });
    // untouched environments keep no state
    expect(model.environments.prod.state).toBeUndefined();
  });
});

describe('flag parsers', () => {
  it('parses --attach and --subscribe values', () => {
    expect(parseAttaches(['api:read-write'])).toEqual([{ consumer: 'api', access: 'read-write' }]);
    expect(parseSubscribes(['platform/events:source=orders,payments:detail-type=OrderPlaced'])).toEqual([
      {
        bus: 'platform/events',
        pattern: { source: ['orders', 'payments'], detailType: ['OrderPlaced'] },
      },
    ]);
  });

  it('rejects malformed values', () => {
    expect(() => parseAttaches(['api'])).toThrow(/Invalid attach/);
    expect(() => parseAttaches(['api:banana'])).toThrow(/Invalid access "banana"/);
    expect(() => parseSubscribes(['platform/events'])).toThrow(/needs a pattern/);
    expect(() => parseSubscribes(['platform/events:nope=1'])).toThrow(/Invalid subscription segment/);
  });
});
