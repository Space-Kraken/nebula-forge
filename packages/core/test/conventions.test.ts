import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { configureNaming, loadWorkspace, resourceNameFor } from '../src';

const createdDirs: string[] = [];
afterEach(() => {
  configureNaming(undefined);
  for (const dir of createdDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const CONVENTIONS_SOURCE = `
module.exports = {
  naming: { pattern: 'corp-{project}-{env}-{module}-{name}' },
  tags: { 'cost-center': 'cc-1234', app: '{project}' },
};
`;

function makeWorkspace(forgeJson: Record<string, unknown>, extraFiles: Record<string, unknown> = {}): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-conv-test-'));
  createdDirs.push(root);
  fs.writeFileSync(path.join(root, 'conventions.js'), CONVENTIONS_SOURCE);
  const files: Record<string, unknown> = {
    'forge.json': {
      name: 'shop',
      engine: 'aws-cdk',
      defaultEnvironment: 'dev',
      environments: { dev: { region: 'us-east-1' } },
      ...forgeJson,
    },
    'domains/billing/domain.json': { name: 'billing' },
    'domains/billing/components/api/component.json': { name: 'api', type: 'http-api' },
    ...extraFiles,
  };
  for (const [relative, content] of Object.entries(files)) {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(content, null, 2));
  }
  return root;
}

describe('inherited conventions (forge.json "conventions")', () => {
  it('inherits naming and tags from the conventions module', () => {
    const model = loadWorkspace(makeWorkspace({ conventions: './conventions.js' }));
    expect(model.naming?.pattern).toBe('corp-{project}-{env}-{module}-{name}');
    expect(model.tags).toEqual({ 'cost-center': 'cc-1234', app: '{project}' });
    expect(resourceNameFor('shop', 'billing', 'api', 'dev')).toBe('corp-shop-dev-billing-api');
    expect(model.warnings).toEqual([]);
  });

  it('rejects inline naming/tags when conventions is declared', () => {
    expect(() =>
      loadWorkspace(makeWorkspace({ conventions: './conventions.js', naming: { separator: '_' } })),
    ).toThrow(/declares "conventions" AND an inline "naming"/);
    expect(() =>
      loadWorkspace(makeWorkspace({ conventions: './conventions.js', tags: { extra: 'x' } })),
    ).toThrow(/declares "conventions" AND an inline "tags"/);
  });

  it('accepts explicit overrides with a visible warning; tags merge per key, naming replaces', () => {
    const model = loadWorkspace(
      makeWorkspace({
        conventions: './conventions.js',
        overrides: { naming: { pattern: 'x-{name}-{env}' }, tags: { extra: 'yes' } },
      }),
    );
    expect(model.naming?.pattern).toBe('x-{name}-{env}');
    expect(model.tags).toEqual({ 'cost-center': 'cc-1234', app: '{project}', extra: 'yes' });
    expect(model.warnings?.[0]).toMatch(/overrides in effect.*deviates from ".\/conventions.js"/);
    expect(resourceNameFor('shop', 'billing', 'api', 'dev')).toBe('x-api-dev');
  });

  it('rejects overrides without conventions, unknown refs and invalid contracts', () => {
    expect(() => loadWorkspace(makeWorkspace({ overrides: { tags: { a: 'b' } } }))).toThrow(
      /"overrides" without "conventions"/,
    );
    expect(() => loadWorkspace(makeWorkspace({ conventions: './missing.js' }))).toThrow(
      /Could not load conventions/,
    );
    const root = makeWorkspace({ conventions: './bad.js' });
    fs.writeFileSync(path.join(root, 'bad.js'), 'module.exports = { naming: { pattern: 42 } };');
    expect(() => loadWorkspace(root)).toThrow(/does not export a valid contract/);
  });

  it('validates the INHERITED contract like an inline one (unknown tokens fail)', () => {
    const root = makeWorkspace({ conventions: './rogue.js' });
    fs.writeFileSync(path.join(root, 'rogue.js'), "module.exports = { naming: { pattern: 'x-{team}-{name}' } };");
    expect(() => loadWorkspace(root)).toThrow(/unknown token \{team\}/);
  });

  it('without conventions everything behaves exactly as before', () => {
    const model = loadWorkspace(makeWorkspace({}));
    expect(model.naming).toBeUndefined();
    expect(model.tags).toBeUndefined();
    expect(model.warnings).toEqual([]);
    expect(resourceNameFor('shop', 'billing', 'api', 'dev')).toBe('shop-billing-api-dev');
  });
});
