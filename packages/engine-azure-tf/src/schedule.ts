import { ForgeError } from '@forgecli/core';

const RATE_PATTERN = /^rate\((\d+)\s+(minute|minutes|hour|hours|day|days)\)$/;

/**
 * Converts the model's schedule expression (AWS-style rate()) to the NCRONTAB
 * format Azure Functions timers use. cron() expressions are EventBridge
 * syntax and do not translate 1:1 — rejected with guidance.
 */
export function toNcrontab(schedule: string): string {
  const match = RATE_PATTERN.exec(schedule.trim());
  if (!match) {
    throw new ForgeError(
      `Schedule "${schedule}" is not supported on the azure-terraform engine`,
      'Use rate(N minutes|hours|days) — EventBridge cron() syntax does not translate to Azure NCRONTAB.',
    );
  }
  const value = Number(match[1]);
  const unit = match[2];
  if (unit.startsWith('minute')) {
    if (value < 1 || value > 59) throw new ForgeError(`rate(${value} minutes) must be between 1 and 59 on Azure timers`);
    return `0 */${value} * * * *`;
  }
  if (unit.startsWith('hour')) {
    if (value < 1 || value > 23) throw new ForgeError(`rate(${value} hours) must be between 1 and 23 on Azure timers`);
    return `0 0 */${value} * * *`;
  }
  if (value < 1 || value > 28) throw new ForgeError(`rate(${value} days) must be between 1 and 28 on Azure timers`);
  return `0 0 0 */${value} * *`;
}
