import { spawn, spawnSync } from 'node:child_process';

/** Stderr tail kept for retry pattern matching — enough context, bounded memory. */
const STDERR_TAIL_BYTES = 32 * 1024;

export interface RetryOptions {
  /** Retry when the process exits non-zero AND its stderr matches this. */
  pattern: RegExp;
  /** Total attempts (first run included). */
  attempts: number;
  delayMs: (attempt: number) => number;
  onRetry: (nextAttempt: number, total: number) => void;
}

function runStreaming(
  root: string,
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ status: number; stderrTail: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: root,
      shell: process.platform === 'win32',
      env,
      // stderr is teed: streamed live to the terminal AND tail-buffered so a
      // retryable failure (Windows EBUSY during asset staging) is detectable.
      stdio: ['inherit', 'inherit', 'pipe'],
    });
    let tail = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      process.stderr.write(chunk);
      tail = (tail + chunk.toString()).slice(-STDERR_TAIL_BYTES);
    });
    child.on('error', (error) => {
      process.stderr.write(`${error.message}\n`);
      resolve({ status: 1, stderrTail: tail });
    });
    child.on('close', (code) => resolve({ status: code ?? 1, stderrTail: tail }));
  });
}

/**
 * Like runInWorkspace, but retries transient failures. Built for the classic
 * aws-cdk-on-Windows race: Defender/indexers hold a handle on freshly written
 * bundle files while AssetStaging renames its temp dir → intermittent EBUSY.
 */
export async function runInWorkspaceRetrying(
  root: string,
  command: string,
  args: string[],
  environment: string | undefined,
  extraEnv: Record<string, string>,
  retry: RetryOptions,
): Promise<number> {
  const env = {
    ...process.env,
    ...(environment ? { FORGE_ENV: environment } : {}),
    ...extraEnv,
  };
  let status = 1;
  for (let attempt = 1; attempt <= retry.attempts; attempt += 1) {
    const result = await runStreaming(root, command, args, env);
    status = result.status;
    if (status === 0 || attempt === retry.attempts || !retry.pattern.test(result.stderrTail)) {
      return status;
    }
    retry.onRetry(attempt + 1, retry.attempts);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, retry.delayMs(attempt)));
  }
  return status;
}

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
