import { spawnSync } from 'node:child_process';

/** Prefers pnpm when it is available on the machine. */
export function detectPackageManager(): 'pnpm' | 'npm' {
  const probe = spawnSync('pnpm', ['--version'], {
    shell: process.platform === 'win32',
    stdio: 'ignore',
  });
  return probe.status === 0 ? 'pnpm' : 'npm';
}

export function runInWorkspace(
  root: string,
  command: string,
  args: string[],
  environment?: string,
  extraEnv?: Record<string, string>,
): number {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: {
      ...process.env,
      ...(environment ? { FORGE_ENV: environment } : {}),
      ...extraEnv,
    },
  });
  return result.status ?? 1;
}

/** Silent probe: true when the command runs successfully. */
export function commandAvailable(command: string, args: string[]): boolean {
  const result = spawnSync(command, args, {
    shell: process.platform === 'win32',
    stdio: 'ignore',
  });
  return result.status === 0;
}
