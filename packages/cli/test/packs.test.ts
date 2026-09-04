import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadWorkspace } from '@space-kraken/nebula-forge-core';
import { afterEach, describe, expect, it } from 'vitest';
import { scaffoldComponent, scaffoldModule, scaffoldWorkspace } from '../src/lib/scaffold';

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
      configSchema: { safeParse: (value) => ({ success: true, data: value ?? {} }) },
      bindable: { access: ['read'], envVar: { prefix: 'SECRET', suffix: 'ARN' } },
      scaffold: [
        { path: 'README.md', content: '# {{name}} in {{module}} ({{pascalName}} / SECRET_{{screamingName}}_ARN)' },
      ],
      engines: { 'aws-cdk': () => ({}) },
    },
  ],
};
`;

function makeWorkspace(): string {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-cli-pack-test-'));
  createdDirs.push(parent);
  const root = path.join(parent, 'shop');
  scaffoldWorkspace({ name: 'shop', targetDir: root, link: false });
  fs.writeFileSync(path.join(root, 'test-pack.js'), PACK_SOURCE);
  const forgeJsonPath = path.join(root, 'forge.json');
  const forgeJson = JSON.parse(fs.readFileSync(forgeJsonPath, 'utf8'));
  forgeJson.packs = ['./test-pack.js'];
  fs.writeFileSync(forgeJsonPath, JSON.stringify(forgeJson, null, 2));
  scaffoldModule(root, 'billing');
  return root;
}

describe('pack component scaffolding', () => {
  it('writes the manifest plus pack scaffold files with all template vars', () => {
    const root = makeWorkspace();
    scaffoldComponent(root, 'billing', { name: 'api-keys', type: 'secret' });

    const componentDir = path.join(root, 'domains', 'billing', 'components', 'api-keys');
    const readme = fs.readFileSync(path.join(componentDir, 'README.md'), 'utf8');
    expect(readme).toBe('# api-keys in billing (ApiKeys / SECRET_API_KEYS_ARN)');

    const model = loadWorkspace(root);
    expect(model.domains[0].packComponents?.[0]).toMatchObject({
      name: 'api-keys',
      type: 'secret',
      pack: 'test-pack',
    });
  });

  it('rejects pack types on engines the pack has no builder for', () => {
    const root = makeWorkspace();
    const forgeJsonPath = path.join(root, 'forge.json');
    const forgeJson = JSON.parse(fs.readFileSync(forgeJsonPath, 'utf8'));
    forgeJson.engine = 'azure-terraform';
    fs.writeFileSync(forgeJsonPath, JSON.stringify(forgeJson, null, 2));
    expect(() => scaffoldComponent(root, 'billing', { name: 'api-keys', type: 'secret' })).toThrow(
      /has no azure-terraform builder/,
    );
  });
});
