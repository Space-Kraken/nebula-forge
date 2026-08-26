import { checkbox, confirm, input, select } from '@inquirer/prompts';

/**
 * Prompts are a convenience layer only: every answer must also be expressible
 * through flags, so scripts and CI never depend on a TTY.
 */
export function canPrompt(noInteractive: boolean): boolean {
  return (
    !noInteractive &&
    Boolean(process.stdin.isTTY) &&
    Boolean(process.stdout.isTTY) &&
    !process.env.CI
  );
}

export interface Choice<T> {
  name: string;
  value: T;
}

export async function promptCheckbox<T>(message: string, choices: Choice<T>[]): Promise<T[]> {
  return checkbox({ message, choices });
}

export async function promptSelect<T>(message: string, choices: Choice<T>[], defaultValue?: T): Promise<T> {
  return select({ message, choices, default: defaultValue });
}

export async function promptInput(message: string, defaultValue?: string): Promise<string> {
  return input({ message, default: defaultValue });
}

export async function promptConfirm(message: string, defaultValue = true): Promise<boolean> {
  return confirm({ message, default: defaultValue });
}
