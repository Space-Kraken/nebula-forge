import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertValidNaming,
  assertValidTags,
  configureNaming,
  defaultNamingPattern,
  loadWorkspace,
  renderTags,
  resourceNameFor,
} from '../src';

const createdDirs: string[] = [];
afterEach(() => {
  configureNaming(undefined);
  for (const dir of createdDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function makeWorkspace(files: Record<string, unknown>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-naming-test-'));
  createdDirs.push(root);
  for (const [relative, content] of Object.entries(files)) {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(content, null, 2));
  }
  return root;
}

const manifest = (extra: Record<string, unknown> = {}) => ({
  name: 'shop',
  engine: 'aws-cdk',
  defaultEnvironment: 'dev',
  environments: { dev: { region: 'us-east-1' } },
  ...extra,
});

describe('naming pattern resolution', () => {
  it('absent config is a byte-for-byte snapshot of the historic convention', () => {
    expect(defaultNamingPattern()).toBe('{project}-{module}-{name}-{env}');
    configureNaming(undefined);
    expect(resourceNameFor('shop', 'billing', 'api', 'dev')).toBe('shop-billing-api-dev');
  });

  it('renders a custom pattern with the fixed token vocabulary', () => {
    configureNaming({ pattern: 'corp-{project}-{env}-{module}-{name}' });
    expect(resourceNameFor('shop', 'billing', 'api', 'dev')).toBe('corp-shop-dev-billing-api');
  });

  it('separator alone re-joins the default dimensions', () => {
    configureNaming({ separator: '_' });
    expect(resourceNameFor('shop', 'billing', 'api', 'dev')).toBe('shop_billing_api_dev');
  });

  it('rejects unknown tokens and patterns without {name}', () => {
    expect(() => assertValidNaming({ pattern: 'corp-{team}-{name}' })).toThrow(/unknown token \{team\}/);
    expect(() => assertValidNaming({ pattern: 'corp-{project}-{env}' })).toThrow(/must include \{name\}/);
    expect(() => assertValidNaming(undefined)).not.toThrow();
  });
});

describe('tag rendering and validation', () => {
  it('renders {project}/{module}/{env} in tag values', () => {
    expect(
      renderTags({ app: '{project}', stage: '{env}', owner: 'platform' }, { project: 'shop', module: 'billing', env: 'dev' }),
    ).toEqual({ app: 'shop', stage: 'dev', owner: 'platform' });
  });

  it('rejects unknown tokens ({name} included), provider limits and azure-forbidden keys', () => {
    expect(() => assertValidTags({ a: '{name}' }, 'aws-cdk')).toThrow(/unknown token \{name\}/);
    expect(() => assertValidTags({ ['k'.repeat(129)]: 'v' }, 'aws-cdk')).toThrow(/128 characters/);
    expect(() => assertValidTags({ a: 'v'.repeat(257) }, 'aws-cdk')).toThrow(/256 characters/);
    expect(() => assertValidTags({ 'cost/center': 'x' }, 'azure-terraform')).toThrow(/Azure rejects/);
    expect(() => assertValidTags({ 'cost/center': 'x' }, 'aws-cdk')).not.toThrow();
  });
});

describe('loadWorkspace with an org naming contract', () => {
  it('activates the pattern and validates rendered names', () => {
    const root = makeWorkspace({
      'forge.json': manifest({ naming: { pattern: 'corp-{project}-{env}-{module}-{name}' } }),
      'domains/billing/domain.json': { name: 'billing' },
      'domains/billing/components/api/component.json': { name: 'api', type: 'http-api' },
    });
    loadWorkspace(root);
    expect(resourceNameFor('shop', 'billing', 'api', 'dev')).toBe('corp-shop-dev-billing-api');
  });

  it('rejects patterns whose rendered names have an invalid charset', () => {
    const root = makeWorkspace({
      'forge.json': manifest({ naming: { pattern: 'corp.{module}.{name}.{env}' } }),
      'domains/billing/domain.json': { name: 'billing' },
      'domains/billing/components/api/component.json': { name: 'api', type: 'http-api' },
    });
    expect(() => loadWorkspace(root)).toThrow(/not a valid AWS resource name/);
  });

  it('rejects function names over the provider limit when a pattern is configured', () => {
    const root = makeWorkspace({
      'forge.json': manifest({ naming: { pattern: `${'x'.repeat(60)}-{name}-{env}` } }),
      'domains/billing/domain.json': { name: 'billing' },
      'domains/billing/components/api/component.json': { name: 'api', type: 'http-api' },
    });
    expect(() => loadWorkspace(root)).toThrow(/64-character function name limit/);
  });

  it('detects collisions on the RENDERED names when the pattern drops a dimension', () => {
    const root = makeWorkspace({
      'forge.json': manifest({ naming: { pattern: '{project}-{name}-{env}' } }),
      'domains/billing/domain.json': { name: 'billing' },
      'domains/billing/components/api/component.json': { name: 'api', type: 'http-api' },
      'domains/users/domain.json': { name: 'users' },
      'domains/users/components/api/component.json': { name: 'api', type: 'http-api' },
    });
    expect(() => loadWorkspace(root)).toThrow(/would share the physical resource name "shop-api-dev"/);
  });

  it('rejects unknown tokens in forge.json with an actionable hint', () => {
    const root = makeWorkspace({
      'forge.json': manifest({ naming: { pattern: 'corp-{team}-{name}' } }),
    });
    expect(() => loadWorkspace(root)).toThrow(/unknown token \{team\}/);
  });
});

describe('unconditional physical-name limits (no naming block required)', () => {
  it('rejects function-like names over 64 chars even with the default convention', () => {
    const longName = `big-${'x'.repeat(60)}`;
    const root = makeWorkspace({
      'forge.json': manifest(),
      'domains/billing/domain.json': { name: 'billing' },
      [`domains/billing/components/${longName}/component.json`]: { name: longName, type: 'http-api' },
    });
    expect(() => loadWorkspace(root)).toThrow(/over the 64-character function name limit/);
  });

  it('rejects event-bus names over the EventBridge limit', () => {
    // the long dimension lives in the project name — component dirs stay
    // short so Windows MAX_PATH is not the thing being tested
    const root = makeWorkspace({
      'forge.json': manifest({ name: `p${'x'.repeat(250)}` }),
      'domains/platform/domain.json': { name: 'platform' },
      'domains/platform/components/events/component.json': { name: 'events', type: 'event-bus' },
    });
    expect(() => loadWorkspace(root)).toThrow(/EventBridge bus name limit/);
  });

  it('rejects azure event-bus names over the Event Grid topic limit', () => {
    const root = makeWorkspace({
      'forge.json': manifest({ engine: 'azure-terraform', name: `p${'x'.repeat(45)}` }),
      'domains/platform/domain.json': { name: 'platform' },
      'domains/platform/components/events/component.json': { name: 'events', type: 'event-bus' },
    });
    expect(() => loadWorkspace(root)).toThrow(/Event Grid topic name limit/);
  });

  it('decorative names (tables, rest apis) are NOT length-limited at load', () => {
    const longName = `tbl-${'x'.repeat(70)}`;
    const root = makeWorkspace({
      'forge.json': manifest(),
      'domains/billing/domain.json': { name: 'billing' },
      [`domains/billing/components/${longName}/component.json`]: {
        name: longName,
        type: 'table',
        config: { partitionKey: { name: 'id' } },
      },
    });
    expect(() => loadWorkspace(root)).not.toThrow();
  });
});
