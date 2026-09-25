import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { configureNaming, loadWorkspace } from '@space-kraken/nebula-forge-core';
import { afterEach, describe, expect, it } from 'vitest';
import { applyConventions, parseConventionsRef, scaffoldWorkspace } from '../src/lib/scaffold';

const createdDirs: string[] = [];
afterEach(() => {
  configureNaming(undefined);
  for (const dir of createdDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function freshRoot(): string {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-cli-conv-'));
  createdDirs.push(parent);
  return path.join(parent, 'acme-shop');
}

describe('forge new --conventions', () => {
  it('parses package refs (subpath, scope, version) and local paths', () => {
    expect(parseConventionsRef('@acme/standards/forge@1.2.0')).toEqual({
      ref: '@acme/standards/forge',
      packageName: '@acme/standards',
      version: '1.2.0',
    });
    expect(parseConventionsRef('acme-standards')).toEqual({ ref: 'acme-standards', packageName: 'acme-standards', version: undefined });
    expect(parseConventionsRef('./standards/forge.js')).toEqual({ ref: './standards/forge.js' });
    expect(() => parseConventionsRef('@acme')).toThrow(/Invalid conventions package/);
  });

  it('pins an npm conventions package in devDependencies (exact version, or latest)', () => {
    const root = freshRoot();
    scaffoldWorkspace({ name: 'acme-shop', targetDir: root, link: false, conventions: '@acme/standards/forge@1.2.0' });
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    expect(pkg.devDependencies['@acme/standards']).toBe('1.2.0');
    // the key itself waits for install: forge.json still loads
    expect(JSON.parse(fs.readFileSync(path.join(root, 'forge.json'), 'utf8')).conventions).toBeUndefined();
    loadWorkspace(root);

    const latest = freshRoot();
    scaffoldWorkspace({ name: 'acme-shop', targetDir: latest, link: false, conventions: 'acme-standards/forge' });
    expect(JSON.parse(fs.readFileSync(path.join(latest, 'package.json'), 'utf8')).devDependencies['acme-standards']).toBe('latest');
  });

  it('activates a local adapter and rolls forge.json back when the contract fails to load', () => {
    const root = freshRoot();
    scaffoldWorkspace({ name: 'acme-shop', targetDir: root, link: false, conventions: './standards/forge.js' });
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    expect(Object.keys(pkg.devDependencies)).not.toContain('./standards/forge.js');
    fs.cpSync(path.resolve(__dirname, '../../../examples/forge-conventions-adapter'), path.join(root, 'standards'), {
      recursive: true,
    });

    // the example adapter needs an account to build execution policy ARNs → rollback
    const before = fs.readFileSync(path.join(root, 'forge.json'), 'utf8');
    expect(() => applyConventions(root, './standards/forge.js')).toThrow(/needs "account" in forge.json/);
    expect(fs.readFileSync(path.join(root, 'forge.json'), 'utf8')).toBe(before);

    const manifest = JSON.parse(before);
    for (const env of Object.keys(manifest.environments)) manifest.environments[env].account = '111122223333';
    fs.writeFileSync(path.join(root, 'forge.json'), JSON.stringify(manifest, null, 2));
    applyConventions(root, './standards/forge.js');
    const written = JSON.parse(fs.readFileSync(path.join(root, 'forge.json'), 'utf8'));
    expect(Object.keys(written).slice(0, 4)).toEqual(['name', 'engine', 'defaultEnvironment', 'conventions']);
    const model = loadWorkspace(root);
    expect(model.naming?.pattern).toBe('{project}-{env}-{module}-{name}');
    expect(model.environments.prod.deploy?.qualifier).toBe('acprod');
  });
});
