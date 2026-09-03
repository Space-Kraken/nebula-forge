import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { configureNaming, loadWorkspace, resourceNameFor } from '@forgecli/core';
import { afterEach, describe, expect, it } from 'vitest';
import { scaffoldComponent, scaffoldModule, scaffoldWorkspace } from '../src/lib/scaffold';

const createdDirs: string[] = [];
afterEach(() => {
  configureNaming(undefined);
  for (const dir of createdDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('workspace scaffolding and org naming', () => {
  it('documents the naming/tags contract (forge.json is strict JSON, so the example lives in the README)', () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-cli-naming-'));
    createdDirs.push(parent);
    const root = path.join(parent, 'shop');
    scaffoldWorkspace({ name: 'shop', targetDir: root, link: false });

    const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
    expect(readme).toContain('"naming"');
    expect(readme).toContain('corp-{project}-{env}-{module}-{name}');
    expect(readme).toContain('Names are identity');

    // no naming block scaffolded: behavior is the historic snapshot
    const forgeJson = JSON.parse(fs.readFileSync(path.join(root, 'forge.json'), 'utf8'));
    expect(forgeJson.naming).toBeUndefined();
    scaffoldModule(root, 'billing');
    scaffoldComponent(root, 'billing', { name: 'api', type: 'http-api' });
    loadWorkspace(root);
    expect(resourceNameFor('shop', 'billing', 'api', 'dev')).toBe('shop-billing-api-dev');
  });

  it('a workspace declaring the contract loads with it active', () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-cli-naming-'));
    createdDirs.push(parent);
    const root = path.join(parent, 'shop');
    scaffoldWorkspace({ name: 'shop', targetDir: root, link: false });
    const forgeJsonPath = path.join(root, 'forge.json');
    const forgeJson = JSON.parse(fs.readFileSync(forgeJsonPath, 'utf8'));
    forgeJson.naming = { pattern: 'corp-{project}-{env}-{module}-{name}' };
    forgeJson.tags = { 'cost-center': 'cc-1234' };
    fs.writeFileSync(forgeJsonPath, JSON.stringify(forgeJson, null, 2));

    scaffoldModule(root, 'billing');
    scaffoldComponent(root, 'billing', { name: 'api', type: 'http-api' });
    const model = loadWorkspace(root);
    expect(model.naming?.pattern).toBe('corp-{project}-{env}-{module}-{name}');
    expect(model.tags).toEqual({ 'cost-center': 'cc-1234' });
    expect(resourceNameFor('shop', 'billing', 'api', 'dev')).toBe('corp-shop-dev-billing-api');
  });
});
