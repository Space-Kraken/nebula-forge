import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { configureNaming } from '@space-kraken/nebula-forge-core';
import { scaffoldModule, scaffoldWorkspace } from '@space-kraken/nebula-forge/dist/lib/scaffold';
import { afterEach, describe, expect, it } from 'vitest';
import {
  attachTool,
  detachTool,
  generateComponent,
  generateEndpoint,
  listModel,
  regenerateDocs,
  removeComponentTool,
  validateWorkspace,
} from '../src/tools';

const createdDirs: string[] = [];
afterEach(() => {
  configureNaming(undefined);
  for (const dir of createdDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function makeWorkspace(): string {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-mcp-test-'));
  createdDirs.push(parent);
  const root = path.join(parent, 'shop');
  scaffoldWorkspace({ name: 'shop', targetDir: root, link: false });
  scaffoldModule(root, 'billing');
  return root;
}

describe('mcp tools (non-interactive, transactional)', () => {
  it('generate_component + attach + list_model + validate_workspace round trip', () => {
    const root = makeWorkspace();
    const api = generateComponent.run({ workspaceRoot: root, module: 'billing', name: 'api', type: 'http-api' });
    expect(api.created).toBe('billing/api');

    const table = generateComponent.run({
      workspaceRoot: root,
      module: 'billing',
      name: 'data',
      type: 'table',
      config: { partitionKey: { name: 'id' } },
      attach: ['api:read-write'],
    });
    expect(table.attached).toEqual(['api → data (read-write)']);

    const verdict = validateWorkspace.run({ workspaceRoot: root });
    expect(verdict).toMatchObject({ valid: true, project: 'shop', warnings: [] });

    const model = listModel.run({ workspaceRoot: root, env: 'dev' }) as {
      schemaVersion: number;
      environments: Record<string, { domains: { components: { name: string; physicalName: string }[] }[] }>;
    };
    expect(model.schemaVersion).toBe(1);
    const names = model.environments.dev.domains[0].components.map((c) => `${c.name}:${c.physicalName}`);
    expect(names).toContain('api:shop-billing-api-dev');

    expect(fs.existsSync(path.join(root, 'AGENTS.md'))).toBe(true);
  });

  it('generate_endpoint wires route + controller through the barrel', () => {
    const root = makeWorkspace();
    generateComponent.run({ workspaceRoot: root, module: 'billing', name: 'api', type: 'http-api' });
    const result = generateEndpoint.run({
      workspaceRoot: root,
      module: 'billing',
      api: 'api',
      name: 'get-invoice',
      method: 'get',
      route: '/invoices/{id}',
    });
    expect(result.endpoint).toBe('GET /invoices/{id}');
    const barrel = fs.readFileSync(
      path.join(root, 'domains', 'billing', 'components', 'api', 'src', 'infrastructure', 'controllers', 'index.ts'),
      'utf8',
    );
    expect(barrel).toContain('GetInvoiceController');
  });

  it('attach/detach edit existing manifests with validation', () => {
    const root = makeWorkspace();
    generateComponent.run({ workspaceRoot: root, module: 'billing', name: 'api', type: 'http-api' });
    generateComponent.run({
      workspaceRoot: root,
      module: 'billing',
      name: 'data',
      type: 'table',
      config: { partitionKey: { name: 'id' } },
    });

    const attached = attachTool.run({ workspaceRoot: root, module: 'billing', component: 'api', bind: ['data:read'] });
    expect(attached.changes).toEqual(['bound: api → data (read)']);
    // an invalid attach rolls the manifest back
    expect(() =>
      attachTool.run({ workspaceRoot: root, module: 'billing', component: 'api', bind: ['missing:read'] }),
    ).toThrow(/unknown component "missing"/);
    const manifest = JSON.parse(
      fs.readFileSync(path.join(root, 'domains', 'billing', 'components', 'api', 'component.json'), 'utf8'),
    );
    expect(manifest.bindings).toEqual([{ component: 'data', access: 'read' }]);

    const detached = detachTool.run({ workspaceRoot: root, module: 'billing', component: 'api', bind: ['data'] });
    expect(detached.changes).toEqual(['unbound: data']);
  });

  it('generate_component is transactional: a failing attach leaves no half-created component', () => {
    const root = makeWorkspace();
    generateComponent.run({ workspaceRoot: root, module: 'billing', name: 'api', type: 'http-api' });
    expect(() =>
      generateComponent.run({
        workspaceRoot: root,
        module: 'billing',
        name: 'data',
        type: 'table',
        config: { partitionKey: { name: 'id' } },
        attach: ['api:publish'],
      }),
    ).toThrow(/does not support "publish"/);
    expect(fs.existsSync(path.join(root, 'domains', 'billing', 'components', 'data'))).toBe(false);
    expect(() => validateWorkspace.run({ workspaceRoot: root })).not.toThrow();
  });

  it('remove_component refuses while referenced, cascades with force', () => {
    const root = makeWorkspace();
    generateComponent.run({ workspaceRoot: root, module: 'billing', name: 'api', type: 'http-api' });
    generateComponent.run({
      workspaceRoot: root,
      module: 'billing',
      name: 'data',
      type: 'table',
      config: { partitionKey: { name: 'id' } },
      attach: ['api:read-write'],
    });

    expect(() =>
      removeComponentTool.run({ workspaceRoot: root, module: 'billing', component: 'data' }),
    ).toThrow(/still used|referenc/i);

    const removed = removeComponentTool.run({
      workspaceRoot: root,
      module: 'billing',
      component: 'data',
      force: true,
    });
    expect(removed.removed).toBe('billing/data');
    expect(removed.detached).toEqual(['billing/api (binding)']);
    expect(() => validateWorkspace.run({ workspaceRoot: root })).not.toThrow();
  });

  it('regenerate_docs rewrites both living documents', () => {
    const root = makeWorkspace();
    fs.rmSync(path.join(root, 'AGENTS.md'), { force: true });
    const result = regenerateDocs.run({ workspaceRoot: root });
    expect(result.written).toContain('AGENTS.md');
    expect(fs.existsSync(path.join(root, 'AGENTS.md'))).toBe(true);
  });
});
