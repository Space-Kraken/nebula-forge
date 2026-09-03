import { createHash } from 'node:crypto';
import { ForgeError } from './errors';
import { packComponentDefinition } from './packs';

/** Naming convention shared by workspaces, domains and components. */
export const NAME_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

export function isValidName(value: string): boolean {
  return NAME_PATTERN.test(value);
}

/** CloudFormation stack name for a domain in a given environment. */
export function stackNameFor(appName: string, domainName: string, environment: string): string {
  return `${appName}-${domainName}-${environment}`;
}

/**
 * Workspace-level naming convention (forge.json "naming"). The organization
 * declares the contract; forge conforms. Names stay a pure function of the
 * model — the config parameterizes the GLOBAL pattern, never per-resource.
 */
export interface NamingConfig {
  /** Template over the fixed vocabulary {project} {module} {name} {env}. */
  pattern?: string;
  /** Joins the default dimensions when no pattern is given (default "-"). */
  separator?: string;
}

/** The exact dimensions resourceNameFor uses — the whole token vocabulary. */
export const NAMING_TOKENS = ['project', 'module', 'name', 'env'] as const;
/** Tokens allowed in tag values: tags are stack-wide, {name} is per-resource. */
export const TAG_TOKENS = ['project', 'module', 'env'] as const;

const DEFAULT_SEPARATOR = '-';

/** Snapshot of the historic convention: absent config must produce these bytes. */
export function defaultNamingPattern(separator: string = DEFAULT_SEPARATOR): string {
  return ['{project}', '{module}', '{name}', '{env}'].join(separator);
}

let activePattern = defaultNamingPattern();

/**
 * Activates a workspace's naming convention. Called by loadWorkspace and by
 * each engine's entry point (from model.naming), so the pattern can never be
 * stale across workspaces in one process. Undefined restores the default.
 */
export function configureNaming(config?: NamingConfig): void {
  activePattern = config?.pattern ?? defaultNamingPattern(config?.separator ?? DEFAULT_SEPARATOR);
}

export function activeNamingPattern(): string {
  return activePattern;
}

/** First unknown token in a template, given the allowed vocabulary. */
function unknownToken(template: string, allowed: readonly string[]): string | undefined {
  for (const match of template.matchAll(/\{([^}]*)\}/g)) {
    if (!allowed.includes(match[1])) return match[0];
  }
  return undefined;
}

/** Load-time validation of forge.json "naming" — bad config never reaches synth. */
export function assertValidNaming(config: NamingConfig | undefined): void {
  if (!config?.pattern) return;
  const bad = unknownToken(config.pattern, NAMING_TOKENS);
  if (bad) {
    throw new ForgeError(
      `forge.json naming.pattern uses unknown token ${bad}`,
      `The vocabulary is fixed: {project}, {module}, {name}, {env} — e.g. "corp-{project}-{env}-{module}-{name}".`,
    );
  }
  if (!config.pattern.includes('{name}')) {
    throw new ForgeError(
      'forge.json naming.pattern must include {name}',
      'Without the component dimension every component in a module renders the same physical name.',
    );
  }
}

function renderTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{([^}]*)\}/g, (_token, key: string) => values[key] ?? '');
}

/**
 * Deterministic physical name for a component's main resource, rendered with
 * the active naming convention. Cross-domain references (event buses, gateway
 * mounts) rely on this being reproducible from the model alone — never derive
 * it from deployed state, and never override it per resource.
 */
export function resourceNameFor(
  appName: string,
  domainName: string,
  componentName: string,
  environment: string,
): string {
  return renderTemplate(activePattern, {
    project: appName,
    module: domainName,
    name: componentName,
    env: environment,
  });
}

/** Renders workspace tag values ({project}/{module}/{env}) for one stack. */
export function renderTags(
  tags: Record<string, string> | undefined,
  dims: { project: string; module: string; env: string },
): Record<string, string> {
  const rendered: Record<string, string> = {};
  for (const [key, value] of Object.entries(tags ?? {})) {
    rendered[key] = renderTemplate(value, dims);
  }
  return rendered;
}

/** Azure forbids these characters in tag keys; AWS is laxer. */
const AZURE_TAG_KEY_FORBIDDEN = /[<>%&\\?/]/;

/** Load-time validation of forge.json "tags" against provider limits. */
export function assertValidTags(tags: Record<string, string> | undefined, engine: string): void {
  for (const [key, value] of Object.entries(tags ?? {})) {
    if (key.length > 128) {
      throw new ForgeError(
        `forge.json tags: key "${key.slice(0, 32)}…" exceeds 128 characters`,
        'AWS caps tag keys at 128 characters (Azure at 512).',
      );
    }
    if (value.length > 256) {
      throw new ForgeError(
        `forge.json tags: value for "${key}" exceeds 256 characters`,
        'Both AWS and Azure cap tag values at 256 characters.',
      );
    }
    if (engine === 'azure-terraform' && AZURE_TAG_KEY_FORBIDDEN.test(key)) {
      throw new ForgeError(
        `forge.json tags: key "${key}" contains a character Azure rejects`,
        'Azure tag keys cannot contain < > % & \\ ? or /.',
      );
    }
    const bad = unknownToken(value, TAG_TOKENS);
    if (bad) {
      throw new ForgeError(
        `forge.json tags: value for "${key}" uses unknown token ${bad}`,
        'Tag values accept {project}, {module} and {env}. {name} is per-resource while tags apply stack-wide, so it is not available.',
      );
    }
  }
}

/** Deterministic 10-hex-char suffix that absorbs truncation without losing uniqueness. */
export function hashSuffix(...parts: string[]): string {
  return createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 10);
}

/**
 * Globally unique kebab name with a length budget: `prefix-…parts`, hash-
 * truncated deterministically when too long. Shared by engine-azure-tf (its
 * short global names) and the model export, so both always agree.
 */
export function globalName(prefix: string, parts: string[], maxLength: number): string {
  const name = [prefix, ...parts].join('-');
  if (name.length <= maxLength) return name;
  const suffix = hashSuffix(...parts);
  return `${name.slice(0, maxLength - suffix.length - 1)}-${suffix}`.replace(/--+/g, '-');
}

/** kebab-case → PascalCase, for construct ids. */
export function toConstructId(name: string): string {
  return name
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}

/** kebab-case → SCREAMING_SNAKE_CASE, for environment variable names. */
export function toEnvVarName(name: string): string {
  return name.replace(/[^a-zA-Z0-9]+/g, '_').toUpperCase();
}

/**
 * Naming convention for the discovery env var a binding injects into its
 * consumer. Single source of truth shared by engines and documentation.
 */
const BINDING_ENV_FORMATS: Record<string, { prefix: string; suffix: string }> = {
  table: { prefix: 'TABLE', suffix: 'NAME' },
  bucket: { prefix: 'BUCKET', suffix: 'NAME' },
  'queue-worker': { prefix: 'QUEUE', suffix: 'URL' },
  topic: { prefix: 'TOPIC', suffix: 'ARN' },
  'event-bus': { prefix: 'BUS', suffix: 'NAME' },
  email: { prefix: 'EMAIL', suffix: 'FROM' },
};

/** Env var injected when binding to targetName, or undefined for non-bindable types. */
export function bindingEnvVarFor(targetType: string, targetName: string): string | undefined {
  const format = BINDING_ENV_FORMATS[targetType] ?? packComponentDefinition(targetType)?.bindable?.envVar;
  if (!format) return undefined;
  return `${format.prefix}_${toEnvVarName(targetName)}_${format.suffix}`;
}
