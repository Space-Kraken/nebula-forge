import { spawnSync } from 'node:child_process';

/** Prefers pnpm when it is available on the machine. */
export function detectPackageManager(): 'pnpm' | 'npm' {
  const probe = spawnSync('pnpm', ['--version'], {
    shell: process.platform === 'win32',
    stdio: 'ignore',
  });
  return probe.status === 0 ? 'pnpm' : 'npm';
}

export function runInWorkspace(root: string, command: string, args: string[], environment?: string): number {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: environment ? { ...process.env, FORGE_ENV: environment } : process.env,
  });
  return result.status ?? 1;
}
