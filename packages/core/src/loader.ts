import * as fs from 'node:fs';
import * as path from 'node:path';
import { ForgeError } from './errors';
import {
  BINDABLE_ACCESS,
  Binding,
  ComponentManifest,
  ComponentSpec,
  CROSS_DOMAIN_BINDABLE_TYPES,
  DomainManifest,
  DomainSpec,
  FUNCTION_LIKE_TYPES,
  WorkspaceManifest,
  WorkspaceModel,
} from './model';
import { isVariableSegment } from './routes';
import { componentManifestSchema, domainManifestSchema, workspaceManifestSchema } from './schema';

export const WORKSPACE_MANIFEST = 'forge.json';
export const DOMAIN_MANIFEST = 'domain.json';
export const COMPONENT_MANIFEST = 'component.json';

/** Walks up from startDir looking for a forge.json. */
export function findWorkspaceRoot(startDir: string): string | undefined {
  let current = path.resolve(startDir);
  for (;;) {
    if (fs.existsSync(path.join(current, WORKSPACE_MANIFEST))) return current;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function readJson(file: string): unknown {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    throw new ForgeError(`Could not read ${file}: ${(error as Error).message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new ForgeError(`${file} is not valid JSON: ${(error as Error).message}`);
  }
}

interface ParseableSchema<T> {
  safeParse(value: unknown): { success: true; data: T } | { success: false; error: { issues: { path: (string | number)[]; message: string }[] } };
}

function parseManifest<T>(schema: ParseableSchema<T>, value: unknown, file: string): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new ForgeError(`Invalid manifest ${file}:\n${issues}`);
  }
  return result.data;
}

/**
 * Loads and validates the full workspace model starting from any directory
 * inside the workspace.
 */
export function loadWorkspace(startDir: string): WorkspaceModel {
  const root = findWorkspaceRoot(startDir);
  if (!root) {
    throw new ForgeError(
      `No ${WORKSPACE_MANIFEST} found in ${path.resolve(startDir)} or any parent directory`,
      'Run this command inside a forge workspace, or create one with `forge new <name>`.',
    );
  }
  const manifest = parseManifest<WorkspaceManifest>(
    workspaceManifestSchema,
    readJson(path.join(root, WORKSPACE_MANIFEST)),
    path.join(root, WORKSPACE_MANIFEST),
  );
  const model: WorkspaceModel = { ...manifest, root, domains: loadDomains(root) };
  validateModel(model);
  return model;
}

function loadDomains(root: string): DomainSpec[] {
  const domainsDir = path.join(root, 'domains');
  if (!fs.existsSync(domainsDir)) return [];
  const domains: DomainSpec[] = [];
  for (const entry of fs.readdirSync(domainsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const domainPath = path.join(domainsDir, entry.name);
    const manifestFile = path.join(domainPath, DOMAIN_MANIFEST);
    if (!fs.existsSync(manifestFile)) continue;
    const manifest = parseManifest<DomainManifest>(domainManifestSchema, readJson(manifestFile), manifestFile);
    if (manifest.name !== entry.name) {
      throw new ForgeError(
        `Domain folder "${entry.name}" declares name "${manifest.name}" — folder and manifest name must match`,
      );
    }
    domains.push({ ...manifest, path: domainPath, components: loadComponents(domainPath) });
  }
  return domains;
}

function loadComponents(domainPath: string): ComponentSpec[] {
  const componentsDir = path.join(domainPath, 'components');
  if (!fs.existsSync(componentsDir)) return [];
  const components: ComponentSpec[] = [];
  for (const entry of fs.readdirSync(componentsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const componentPath = path.join(componentsDir, entry.name);
    const manifestFile = path.join(componentPath, COMPONENT_MANIFEST);
    if (!fs.existsSync(manifestFile)) continue;
    const manifest = parseManifest<ComponentManifest>(componentManifestSchema, readJson(manifestFile), manifestFile);
    if (manifest.name !== entry.name) {
      throw new ForgeError(
        `Component folder "${entry.name}" declares name "${manifest.name}" — folder and manifest name must match`,
      );
    }
    components.push({ ...manifest, path: componentPath } as ComponentSpec);
  }
  return components;
}

export interface ResolvedBinding {
  domain: DomainSpec;
  component: ComponentSpec;
}

/**
 * Resolves a component reference ("name" or "domain/name") from the point of
 * view of fromDomain. Returns undefined when the target does not exist.
 */
export function resolveBinding(
  model: WorkspaceModel,
  fromDomain: DomainSpec,
  reference: Binding | string,
): ResolvedBinding | undefined {
  const ref = typeof reference === 'string' ? reference : reference.component;
  const slash = ref.indexOf('/');
  const domainName = slash === -1 ? fromDomain.name : ref.slice(0, slash);
  const componentName = slash === -1 ? ref : ref.slice(slash + 1);
  const domain = model.domains.find((candidate) => candidate.name === domainName);
  const component = domain?.components.find((candidate) => candidate.name === componentName);
  return domain && component ? { domain, component } : undefined;
}

function validateModel(model: WorkspaceModel): void {
  validatePhysicalNames(model);
  for (const domain of model.domains) {
    for (const component of domain.components) {
      validateBindings(model, domain, component);
      validateSubscriptions(model, domain, component);
      validateRoutes(domain, component);
    }
  }
}

/**
 * API Gateway allows only ONE variable path part per resource level, and
 * rejects the stack at deploy time otherwise — catch it when loading instead.
 */
function validateRoutes(domain: DomainSpec, component: ComponentSpec): void {
  if (component.type !== 'http-api') return;
  const variableChildren = new Map<string, string>();
  for (const route of component.config.routes) {
    if (route.path === '/') continue;
    let parent = '';
    for (const segment of route.path.slice(1).split('/')) {
      if (isVariableSegment(segment)) {
        const existing = variableChildren.get(parent);
        if (existing && existing !== segment) {
          throw new ForgeError(
            `Component "${domain.name}/${component.name}" declares sibling path variables "${existing}" and "${segment}" under "${parent || '/'}"`,
            'API Gateway allows only one variable path part per resource level — use the same parameter name in every route (e.g. always {id}).',
          );
        }
        variableChildren.set(parent, segment);
      }
      parent = `${parent}/${segment}`;
    }
  }
}

/**
 * Physical names join app-domain-component with dashes, and names may contain
 * dashes themselves, so e.g. pay/ments-x and pay-ments/x would both claim
 * "app-pay-ments-x-<env>". Deploys would fail (or cross-domain by-name
 * references become ambiguous), so reject the workspace up front.
 */
function validatePhysicalNames(model: WorkspaceModel): void {
  const owners = new Map<string, string>();
  for (const domain of model.domains) {
    for (const component of domain.components) {
      const flattened = `${model.name}-${domain.name}-${component.name}`;
      const owner = owners.get(flattened);
      if (owner) {
        throw new ForgeError(
          `Components "${owner}" and "${domain.name}/${component.name}" would share the physical resource name "${flattened}-<env>"`,
          'Dash-ambiguous domain/component names collide when joined. Rename one of the components (or domains) so the flattened names differ.',
        );
      }
      owners.set(flattened, `${domain.name}/${component.name}`);
    }
  }
}

function validateBindings(model: WorkspaceModel, domain: DomainSpec, component: ComponentSpec): void {
  if (component.bindings.length > 0 && !FUNCTION_LIKE_TYPES.includes(component.type)) {
    throw new ForgeError(
      `Component "${domain.name}/${component.name}" of type "${component.type}" cannot declare bindings`,
      'Only function, http-api and queue-worker components run code and can bind to other components.',
    );
  }
  const boundTargets = new Set<string>();
  for (const binding of component.bindings) {
    const resolved = resolveBinding(model, domain, binding);
    if (!resolved) {
      throw new ForgeError(
        `Component "${domain.name}/${component.name}" binds to unknown component "${binding.component}"`,
        'Bindings target components in the same domain by name, or an event-bus in another domain as "domain/name". All other cross-domain integration flows through events, keeping each domain independently deployable.',
      );
    }
    if (resolved.domain.name === domain.name && resolved.component.name === component.name) {
      throw new ForgeError(`Component "${domain.name}/${component.name}" cannot bind to itself`);
    }
    const targetKey = `${resolved.domain.name}/${resolved.component.name}`;
    if (boundTargets.has(targetKey)) {
      throw new ForgeError(
        `Component "${domain.name}/${component.name}" declares multiple bindings to "${targetKey}"`,
        'Declare a single binding per target; use the access mode that covers everything you need (e.g. read-write instead of read + write).',
      );
    }
    boundTargets.add(targetKey);
    if (resolved.domain.name !== domain.name && !CROSS_DOMAIN_BINDABLE_TYPES.includes(resolved.component.type)) {
      throw new ForgeError(
        `Component "${domain.name}/${component.name}" binds across domains to "${binding.component}" (${resolved.component.type})`,
        'Only event-bus components accept cross-domain bindings; everything else stays domain-private so stacks remain independently deployable.',
      );
    }
    const allowed = BINDABLE_ACCESS[resolved.component.type];
    if (!allowed) {
      throw new ForgeError(
        `Component "${domain.name}/${component.name}" binds to "${binding.component}", but components of type "${resolved.component.type}" cannot be a binding target`,
      );
    }
    if (!allowed.includes(binding.access)) {
      throw new ForgeError(
        `Component type "${resolved.component.type}" does not support "${binding.access}" bindings (allowed: ${allowed.join(', ')})`,
      );
    }
  }
}

function validateSubscriptions(model: WorkspaceModel, domain: DomainSpec, component: ComponentSpec): void {
  if (component.type !== 'queue-worker' && component.type !== 'function') return;
  if (component.type === 'queue-worker' && component.config.fifo && component.config.subscriptions.length > 0) {
    throw new ForgeError(
      `Component "${domain.name}/${component.name}" is a FIFO queue-worker with event-bus subscriptions`,
      'EventBridge cannot deliver to FIFO queues without a message group id, so the deployed rule would never work. Use a standard (non-FIFO) queue-worker for event subscriptions.',
    );
  }
  const seenSubscriptions = new Set<string>();
  for (const subscription of component.config.subscriptions) {
    const key = JSON.stringify([
      subscription.bus,
      subscription.pattern.source ?? null,
      subscription.pattern.detailType ?? null,
    ]);
    if (seenSubscriptions.has(key)) {
      throw new ForgeError(
        `Component "${domain.name}/${component.name}" declares the same subscription to "${subscription.bus}" twice`,
        'Duplicate rules deliver every matching event twice — remove one of the identical subscriptions.',
      );
    }
    seenSubscriptions.add(key);
    const resolved = resolveBinding(model, domain, subscription.bus);
    if (!resolved) {
      throw new ForgeError(
        `Component "${domain.name}/${component.name}" subscribes to unknown bus "${subscription.bus}"`,
        'Reference an event-bus component as "name" (same domain) or "domain/name".',
      );
    }
    if (resolved.component.type !== 'event-bus') {
      throw new ForgeError(
        `Component "${domain.name}/${component.name}" subscribes to "${subscription.bus}", which is a ${resolved.component.type}, not an event-bus`,
      );
    }
  }
}
