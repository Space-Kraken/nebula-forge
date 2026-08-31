import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { bindingEnvVarFor, loadWorkspace, renderAgentGuide } from '../src';

const createdDirs: string[] = [];
afterEach(() => {
  for (const dir of createdDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const PACK_SOURCE = `
module.exports = {
  name: 'test-pack',
  components: [
    {
      type: 'secret',
      description: 'a secret store',
      // duck-typed schema: the loader only calls safeParse
      configSchema: { safeParse: (value) => ({ success: true, data: value ?? {} }) },
      bindable: { access: ['read'], envVar: { prefix: 'SECRET', suffix: 'ARN' } },
      docs: { badge: '🔑' },
      engines: { 'aws-cdk': () => ({}) },
    },
  ],
};
`;

function makeWorkspace(components: Record<string, unknown>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-packs-test-'));
  createdDirs.push(root);
  fs.writeFileSync(path.join(root, 'test-pack.js'), PACK_SOURCE);
  const files: Record<string, unknown> = {
    'forge.json': {
      name: 'shop',
      engine: 'aws-cdk',
      defaultEnvironment: 'dev',
      environments: { dev: { region: 'us-east-1' } },
      packs: ['./test-pack.js'],
    },
    'domains/billing/domain.json': { name: 'billing' },
    ...components,
  };
  for (const [relative, content] of Object.entries(files)) {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(content, null, 2));
  }
  return root;
}

describe('component packs', () => {
  it('loads pack components and resolves their binding env vars', () => {
    const root = makeWorkspace({
      'domains/billing/components/vault/component.json': { name: 'vault', type: 'secret' },
      'domains/billing/components/mailer/component.json': {
        name: 'mailer',
        type: 'function',
        bindings: [{ component: 'vault', access: 'read' }],
      },
    });
    const model = loadWorkspace(root);
    const billing = model.domains[0];
    expect(billing.packComponents).toHaveLength(1);
    expect(billing.packComponents?.[0]).toMatchObject({ name: 'vault', type: 'secret', pack: 'test-pack' });
    expect(bindingEnvVarFor('secret', 'vault')).toBe('SECRET_VAULT_ARN');

    const guide = renderAgentGuide(model);
    expect(guide).toContain('`vault` (secret, pack test-pack)');
    expect(guide).toContain('Never hand-edit');
  });

  it('rejects unsupported access modes on pack targets', () => {
    const root = makeWorkspace({
      'domains/billing/components/vault/component.json': { name: 'vault', type: 'secret' },
      'domains/billing/components/mailer/component.json': {
        name: 'mailer',
        type: 'function',
        bindings: [{ component: 'vault', access: 'write' }],
      },
    });
    expect(() => loadWorkspace(root)).toThrow(/does not support "write" bindings \(allowed: read\)/);
  });

  it('rejects pack components that declare bindings (passive in v1)', () => {
    const root = makeWorkspace({
      'domains/billing/components/vault/component.json': {
        name: 'vault',
        type: 'secret',
        bindings: [{ component: 'x', access: 'read' }],
      },
    });
    expect(() => loadWorkspace(root)).toThrow(/cannot declare bindings/);
  });

  it('unknown types mention both built-ins and loaded pack types', () => {
    const root = makeWorkspace({
      'domains/billing/components/thing/component.json': { name: 'thing', type: 'wat' },
    });
    expect(() => loadWorkspace(root)).toThrow(/unknown type "wat"/);
  });
});
