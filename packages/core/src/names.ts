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
 * Deterministic physical name for a component's main resource. Cross-domain
 * references (event buses) rely on this being reproducible from the model
 * alone — never derive it from deployed state.
 */
export function resourceNameFor(
  appName: string,
  domainName: string,
  componentName: string,
  environment: string,
): string {
  return `${appName}-${domainName}-${componentName}-${environment}`;
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
};

/** Env var injected when binding to targetName, or undefined for non-bindable types. */
export function bindingEnvVarFor(targetType: string, targetName: string): string | undefined {
  const format = BINDING_ENV_FORMATS[targetType];
  if (!format) return undefined;
  return `${format.prefix}_${toEnvVarName(targetName)}_${format.suffix}`;
}
