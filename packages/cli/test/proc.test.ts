import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runInWorkspaceRetrying } from '../src/lib/proc';

const createdDirs: string[] = [];
afterEach(() => {
  for (const dir of createdDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** Script that fails with an EBUSY-looking stderr until its marker file exists. */
const FLAKY_SCRIPT = `
const fs = require('node:fs');
const marker = process.argv[2];
fs.appendFileSync(marker + '.attempts', 'x');
if (!fs.existsSync(marker)) {
  fs.writeFileSync(marker, '1');
  console.error("EBUSY: resource busy or locked, rename 'cdk.out/bundling-temp-abc-building'");
  process.exit(1);
}
process.exit(0);
`;

function writeScript(source: string): { dir: string; script: string; marker: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-proc-test-'));
  createdDirs.push(dir);
  const script = path.join(dir, 'flaky.js');
  fs.writeFileSync(script, source);
  return { dir, script, marker: path.join(dir, 'marker') };
}

describe('runInWorkspaceRetrying', () => {
  it('retries when stderr matches the pattern and succeeds on the second attempt', async () => {
    const { dir, script, marker } = writeScript(FLAKY_SCRIPT);
    const retries: number[] = [];
    const status = await runInWorkspaceRetrying(dir, 'node', [script, marker], undefined, {}, {
      pattern: /EBUSY: resource busy or locked/,
      attempts: 3,
      delayMs: () => 10,
      onRetry: (nextAttempt) => retries.push(nextAttempt),
    });
    expect(status).toBe(0);
    expect(retries).toEqual([2]);
    expect(fs.readFileSync(`${marker}.attempts`, 'utf8')).toBe('xx');
  });

  it('does not retry failures whose stderr does not match', async () => {
    const { dir, script, marker } = writeScript(`
      const fs = require('node:fs');
      fs.appendFileSync(process.argv[2] + '.attempts', 'x');
      console.error('SyntaxError: something is genuinely broken');
      process.exit(1);
    `);
    const retries: number[] = [];
    const status = await runInWorkspaceRetrying(dir, 'node', [script, marker], undefined, {}, {
      pattern: /EBUSY: resource busy or locked/,
      attempts: 3,
      delayMs: () => 10,
      onRetry: (nextAttempt) => retries.push(nextAttempt),
    });
    expect(status).toBe(1);
    expect(retries).toEqual([]);
    expect(fs.readFileSync(`${marker}.attempts`, 'utf8')).toBe('x');
  });
});
