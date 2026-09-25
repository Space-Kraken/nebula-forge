import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { configureNaming, loadWorkspace, resourceNameFor, validateConventions } from '../src';

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

const ADAPTER_SOURCE = `
module.exports = function (ctx) {
  const environments = {};
  for (const [env, spec] of Object.entries(ctx.environments)) {
    environments[env] = { deploy: { qualifier: 'org' + env, permissionsBoundary: 'org-boundary',
      executionPolicies: ['arn:aws:iam::' + (spec.account ?? '000000000000') + ':policy/org-' + env] } };
  }
  return {
    schemaVersion: 1,
    naming: { pattern: '{project}-{env}-{module}-{name}' },
    tags: { 'org:root': ctx.root, 'org:name': ctx.name, 'org:engine': ctx.engine, 'org:contract': String(ctx.forge.conventionsSchemaVersion) },
    environments,
  };
};
`;

describe('conventions adapters (function exports)', () => {
  it('calls the adapter with the workspace context and merges deploy identity per environment', () => {
    const root = makeWorkspace(
      { conventions: './adapter.js', environments: { dev: { region: 'us-east-1', account: '111122223333' }, qa: { region: 'us-east-1' } } },
    );
    fs.writeFileSync(path.join(root, 'adapter.js'), ADAPTER_SOURCE);
    const model = loadWorkspace(root);
    expect(model.naming?.pattern).toBe('{project}-{env}-{module}-{name}');
    expect(model.tags).toEqual({ 'org:root': root, 'org:name': 'shop', 'org:engine': 'aws-cdk', 'org:contract': '1' });
    expect(model.environments.dev.deploy).toEqual({
      qualifier: 'orgdev',
      permissionsBoundary: 'org-boundary',
      executionPolicies: ['arn:aws:iam::111122223333:policy/org-dev'],
    });
    expect(model.environments.qa.deploy?.qualifier).toBe('orgqa');
    expect(model.environments.dev.account).toBe('111122223333');
    expect(model.warnings).toEqual([]);
    expect(resourceNameFor('shop', 'billing', 'api', 'dev')).toBe('shop-dev-billing-api');
  });

  it('rejects an inline deploy block once the contract owns deployment identity; overrides replace it with a warning', () => {
    const root = makeWorkspace({
      conventions: './adapter.js',
      environments: { dev: { region: 'us-east-1', deploy: { qualifier: 'mine' } } },
    });
    fs.writeFileSync(path.join(root, 'adapter.js'), ADAPTER_SOURCE);
    expect(() => loadWorkspace(root)).toThrow(/"conventions" AND an inline "deploy" block on environment "dev"/);

    const overridden = makeWorkspace({
      conventions: './adapter.js',
      overrides: { environments: { dev: { deploy: { qualifier: 'mine' } } } },
    });
    fs.writeFileSync(path.join(overridden, 'adapter.js'), ADAPTER_SOURCE);
    const model = loadWorkspace(overridden);
    expect(model.environments.dev.deploy).toEqual({ qualifier: 'mine' });
    expect(model.warnings?.[0]).toMatch(/deviates from ".\/adapter.js" \(environments\)/);
  });

  it('a contract without environments leaves inline deploy blocks alone', () => {
    const model = loadWorkspace(
      makeWorkspace({ conventions: './conventions.js', environments: { dev: { region: 'us-east-1', deploy: { qualifier: 'mine' } } } }),
    );
    expect(model.environments.dev.deploy).toEqual({ qualifier: 'mine' });
    expect(model.warnings).toEqual([]);
  });

  it('surfaces adapter errors, rejects promises and unknown contract versions', () => {
    const root = makeWorkspace({ conventions: './throwing.js' });
    fs.writeFileSync(path.join(root, 'throwing.js'), "module.exports = () => { throw new Error('ix.config.json missing'); };");
    expect(() => loadWorkspace(root)).toThrow(/Conventions ".\/throwing.js" failed: ix.config.json missing/);

    const async = makeWorkspace({ conventions: './async.js' });
    fs.writeFileSync(path.join(async, 'async.js'), 'module.exports = async () => ({});');
    expect(() => loadWorkspace(async)).toThrow(/returned a Promise/);

    const future = makeWorkspace({ conventions: './future.js' });
    fs.writeFileSync(path.join(future, 'future.js'), 'module.exports = () => ({ schemaVersion: 2, naming: {} });');
    expect(() => loadWorkspace(future)).toThrow(/targets contract schemaVersion 2; this forge speaks 1/);
  });

  it('inherited deploy identity is still rejected on the azure-terraform engine', () => {
    const root = makeWorkspace(
      { conventions: './adapter.js', engine: 'azure-terraform', environments: { dev: { region: 'westeurope' } } },
      { 'domains/billing/components/api/component.json': { name: 'api', type: 'function' } },
    );
    fs.writeFileSync(path.join(root, 'adapter.js'), ADAPTER_SOURCE);
    expect(() => loadWorkspace(root)).toThrow(/"deploy" block, which the azure-terraform engine does not support/);
  });

  it('the example adapter maps an org vocabulary onto the contract end to end', () => {
    const root = makeWorkspace({
      name: 'acme-shop',
      conventions: './standards/forge.js',
      environments: { dev: { region: 'us-east-1', account: '111122223333' } },
    });
    fs.cpSync(path.resolve(__dirname, '../../../examples/forge-conventions-adapter'), path.join(root, 'standards'), {
      recursive: true,
    });
    const model = loadWorkspace(root);
    expect(model.naming?.pattern).toBe('{project}-{env}-{module}-{name}');
    expect(model.tags).toEqual({
      builtin: false,
      'acme:app': '{project}',
      'acme:stage': '{env}',
      'acme:domain': '{module}',
      'acme:cost-center': 'cc-0001',
      'acme:managed-by': 'cdk',
    });
    expect(model.environments.dev.deploy).toEqual({
      qualifier: 'acdev',
      permissionsBoundary: 'acme-platform-boundary',
      executionPolicies: [
        'arn:aws:iam::111122223333:policy/acme-box-dev-compute',
        'arn:aws:iam::111122223333:policy/acme-box-dev-data',
        'arn:aws:iam::111122223333:policy/acme-box-dev-edge',
      ],
    });
    expect(resourceNameFor('acme-shop', 'billing', 'api', 'dev')).toBe('acme-shop-dev-billing-api');
  });

  it('validateConventions lets adapters unit-test their output without a workspace', () => {
    expect(validateConventions({ schemaVersion: 1, naming: { pattern: '{project}-{name}' } })).toEqual({
      schemaVersion: 1,
      naming: { pattern: '{project}-{name}' },
    });
    expect(() => validateConventions({ naming: { template: 'x' } })).toThrow(/does not export a valid contract/);
    expect(() => validateConventions({ schemaVersion: 3 })).toThrow(/schemaVersion 3/);
  });
});
