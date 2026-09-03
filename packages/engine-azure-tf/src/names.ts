import { createHash } from 'node:crypto';
import { globalName, hashSuffix } from '@forgecli/core';

/**
 * Azure naming: several resource kinds have short, lowercase-alphanumeric,
 * globally unique names. Everything stays deterministic — cross-domain
 * references reconstruct names from the model alone — with a content hash to
 * absorb truncation. globalName/hashSuffix live in core (shared with the
 * model export) and are re-exported here.
 */
export { globalName, hashSuffix };

/** Storage accounts: 3-24 chars, lowercase letters/digits only, globally unique. */
export function storageAccountName(appName: string, domainName: string, environment: string): string {
  const base = `st${`${appName}${domainName}${environment}`.replace(/[^a-z0-9]/g, '')}`.slice(0, 14);
  return `${base}${hashSuffix(appName, domainName, environment)}`.slice(0, 24);
}

/** Resource group for a domain in an environment. */
export function resourceGroupName(appName: string, domainName: string, environment: string): string {
  return `rg-${appName}-${domainName}-${environment}`;
}

/** Terraform block labels: letters, digits, underscores and dashes. */
export function tfLabel(...parts: string[]): string {
  return parts.join('_').replace(/[^A-Za-z0-9_-]/g, '_');
}

/** RFC 4122 name-based (v5-style) UUID — Cosmos SQL role assignments need GUID names. */
export function deterministicGuid(...parts: string[]): string {
  const hash = createHash('sha1').update(parts.join('|')).digest();
  hash[6] = (hash[6] & 0x0f) | 0x50;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
