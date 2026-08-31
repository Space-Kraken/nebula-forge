import * as fs from 'node:fs';
import * as path from 'node:path';
import { ForgeError } from './errors';
import {
  AnyComponentSpec,
  bindableAccessFor,
  Binding,
  BUILTIN_COMPONENT_TYPES,
  ComponentManifest,
  ComponentSpec,
  CROSS_DOMAIN_BINDABLE_TYPES,
  DomainManifest,
  DomainSpec,
  FUNCTION_LIKE_TYPES,
  WorkspaceManifest,
  WorkspaceModel,
} from './model';
import { loadPacks, packComponentDefinition, packComponentTypes } from './packs';
import type { PackComponentSpec } from './packs';
import { resourceNameFor } from './names';
import { isVariableSegment } from './routes';
import { z } from 'zod';
import {
  bindingSchema,
  componentManifestSchema,
  domainManifestSchema,
  nameSchema,
  workspaceManifestSchema,
} from './schema';

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
  loadPacks(root, manifest.packs);
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
    const { components, packComponents } = loadComponents(domainPath);
    domains.push({ ...manifest, path: domainPath, components, packComponents });
  }
  return domains;
}

const packManifestBaseSchema = z
  .object({
    name: nameSchema,
    type: z.string(),
    description: z.string().optional(),
    bindings: z.array(bindingSchema).default([]),
    config: z.unknown().optional(),
  })
  .strict();

function loadComponents(domainPath: string): {
  components: ComponentSpec[];
  packComponents: PackComponentSpec[];
} {
  const componentsDir = path.join(domainPath, 'components');
  const components: ComponentSpec[] = [];
  const packComponents: PackComponentSpec[] = [];
  if (!fs.existsSync(componentsDir)) return { components, packComponents };

  for (const entry of fs.readdirSync(componentsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const componentPath = path.join(componentsDir, entry.name);
    const manifestFile = path.join(componentPath, COMPONENT_MANIFEST);
    if (!fs.existsSync(manifestFile)) continue;
    const raw = readJson(manifestFile) as { name?: string; type?: string };

    if ((BUILTIN_COMPONENT_TYPES as readonly string[]).includes(raw.type ?? '')) {
      const manifest = parseManifest<ComponentManifest>(componentManifestSchema, raw, manifestFile);
      if (manifest.name !== entry.name) {
        throw new ForgeError(
          `Component folder "${entry.name}" declares name "${manifest.name}" — folder and manifest name must match`,
        );
      }
      components.push({ ...manifest, path: componentPath } as ComponentSpec);
      continue;
    }

    const definition = packComponentDefinition(raw.type ?? '');
    if (!definition) {
      throw new ForgeError(
        `Component "${entry.name}" has unknown type "${raw.type}"`,
        `Built-in types: ${BUILTIN_COMPONENT_TYPES.join(', ')}. Pack types loaded: ${
          packComponentTypes().join(', ') || '(none)'
        }. Packs are declared in forge.json "packs".`,
      );
    }
    const base = parseManifest<z.infer<typeof packManifestBaseSchema>>(packManifestBaseSchema, raw, manifestFile);
    if (base.name !== entry.name) {
      throw new ForgeError(
        `Component folder "${entry.name}" declares name "${base.name}" — folder and manifest name must match`,
      );
    }
    if (base.bindings.length > 0) {
      throw new ForgeError(
        `Component "${base.name}" (pack type "${definition.type}") cannot declare bindings`,
        'Pack components are passive resources: function-like components bind TO them, not the other way around.',
      );
    }
    const config = definition.configSchema.safeParse(base.config ?? {});
    if (!config.success) {
      const issues = config.error.issues
        .map((issue) => `  - config.${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('\n');
      throw new ForgeError(`Invalid manifest ${manifestFile} (pack "${definition.pack}"):\n${issues}`);
    }
    packComponents.push({
      name: base.name,
      type: definition.type,
      description: base.description,
      bindings: [],
      config: config.data as Record<string, unknown>,
      path: componentPath,
      pack: definition.pack,
    });
  }
  return { components, packComponents };
}

export interface ResolvedBinding {
  domain: DomainSpec;
  component: AnyComponentSpec;
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
  const component =
    domain?.components.find((candidate) => candidate.name === componentName) ??
    domain?.packComponents?.find((candidate) => candidate.name === componentName);
  return domain && component ? { domain, component } : undefined;
}

function validateModel(model: WorkspaceModel): void {
  validatePhysicalNames(model);
  for (const domain of model.domains) {
    for (const component of domain.components) {
      validateBindings(model, domain, component);
      validateSubscriptions(model, domain, component);
      validateAuth(domain, component);
      validateEdge(model, domain, component);
    }
  }
  validateApiRoutes(model);
}

/**
 * Edge config: a static-site's `api` (served behind CloudFront under /api/*)
 * must be a same-module gateway or unmounted http-api; cors/domain belong to
 * whoever actually owns the REST API (never a mounted api); custom-domain
 * environment restrictions must name real environments.
 */
function validateEdge(model: WorkspaceModel, domain: DomainSpec, component: ComponentSpec): void {
  if (component.type === 'http-api' && component.config.mount) {
    for (const key of ['cors', 'domain'] as const) {
      if (component.config[key] !== undefined) {
        throw new ForgeError(
          `Component "${domain.name}/${component.name}" is mounted on a gateway but declares its own ${key}`,
          `A mounted api has no REST API of its own — set ${key} on the gateway component instead.`,
        );
      }
    }
  }

  const domainConfig =
    component.type === 'static-site' || component.type === 'gateway' || component.type === 'http-api'
      ? component.config.domain
      : undefined;
  for (const environment of domainConfig?.environments ?? []) {
    if (!model.environments[environment]) {
      throw new ForgeError(
        `Component "${domain.name}/${component.name}": domain.environments names unknown environment "${environment}"`,
        `Environments in forge.json: ${Object.keys(model.environments).join(', ')}.`,
      );
    }
  }

  if (component.type !== 'static-site' || !component.config.api) return;
  const apiName = component.config.api;
  const target = domain.components.find((candidate) => candidate.name === apiName);
  if (!target) {
    throw new ForgeError(
      `Component "${domain.name}/${component.name}" references unknown api component "${apiName}"`,
      'The api served behind a static-site lives in the SAME module (REST API ids are not addressable by deterministic name).',
    );
  }
  if (target.type !== 'gateway' && target.type !== 'http-api') {
    throw new ForgeError(
      `Component "${domain.name}/${component.name}" references "${apiName}" as api, but it is a ${target.type}`,
      'Point config.api at a gateway or an http-api component.',
    );
  }
  if (target.type === 'http-api' && target.config.mount) {
    throw new ForgeError(
      `Component "${domain.name}/${component.name}" serves "${apiName}", but that api is mounted on a gateway`,
      `A mounted api has no REST API of its own — point config.api at the gateway ("${target.config.mount}") instead.`,
    );
  }
}

/**
 * Auth attachments are same-module by design: identity pool ids are not
 * deterministic, so the authorizer and its API must share a stack.
 */
function validateAuth(domain: DomainSpec, component: ComponentSpec): void {
  if (component.type !== 'gateway' && component.type !== 'http-api') return;
  const authName = component.config.auth;
  if (!authName) return;

  if (component.type === 'http-api' && component.config.mount) {
    throw new ForgeError(
      `Component "${domain.name}/${component.name}" is mounted on a gateway but declares its own auth`,
      'A mounted api inherits the gateway\'s authorizer — set auth on the gateway component instead.',
    );
  }
  const target = domain.components.find((candidate) => candidate.name === authName);
  if (!target) {
    throw new ForgeError(
      `Component "${domain.name}/${component.name}" references unknown auth component "${authName}"`,
      'Auth components live in the SAME module as the API they protect (identity pools are not addressable by deterministic name).',
    );
  }
  if (target.type !== 'auth') {
    throw new ForgeError(
      `Component "${domain.name}/${component.name}" references "${authName}" as auth, but it is a ${target.type}`,
    );
  }
}

interface ApiGroupMember {
  domain: DomainSpec;
  component: Extract<ComponentSpec, { type: 'http-api' }>;
}

/**
 * Route validation runs per ROUTE GROUP: every http-api mounted on the same
 * gateway shares one API Gateway, so duplicate routes and sibling path
 * variables must be consistent across all of them (API Gateway allows only
 * one variable path part per resource level and rejects the deploy
 * otherwise). Unmounted http-apis form their own single-member group.
 */
function validateApiRoutes(model: WorkspaceModel): void {
  const groups = new Map<string, { label: string; members: ApiGroupMember[] }>();

  for (const domain of model.domains) {
    for (const component of domain.components) {
      if (component.type !== 'http-api') continue;
      let key = `self:${domain.name}/${component.name}`;
      let label = `"${domain.name}/${component.name}"`;

      if (component.config.mount) {
        const resolved = resolveBinding(model, domain, component.config.mount);
        if (!resolved) {
          throw new ForgeError(
            `Component "${domain.name}/${component.name}" mounts unknown gateway "${component.config.mount}"`,
            'Reference a gateway component as "name" (same domain) or "domain/name".',
          );
        }
        if (resolved.component.type !== 'gateway') {
          throw new ForgeError(
            `Component "${domain.name}/${component.name}" mounts "${component.config.mount}", which is a ${resolved.component.type}, not a gateway`,
          );
        }
        // The gateway integrates this Lambda by deterministic ARN, so the
        // physical function name must exist (Lambda caps names at 64 chars).
        for (const envName of Object.keys(model.environments)) {
          const physical = resourceNameFor(model.name, domain.name, component.name, envName);
          if (physical.length > 64) {
            throw new ForgeError(
              `Component "${domain.name}/${component.name}" cannot mount a gateway: its physical name "${physical}" exceeds Lambda's 64-character limit`,
              'Shorten the app, module or component name.',
            );
          }
        }
        key = `gw:${resolved.domain.name}/${resolved.component.name}`;
        label = `gateway "${resolved.domain.name}/${resolved.component.name}"`;
      }

      const group = groups.get(key) ?? { label, members: [] };
      group.members.push({ domain, component });
      groups.set(key, group);
    }
  }

  for (const group of groups.values()) {
    const routeOwners = new Map<string, string>();
    const variableChildren = new Map<string, { segment: string; owner: string }>();
    for (const member of group.members) {
      const owner = `${member.domain.name}/${member.component.name}`;
      for (const route of member.component.config.routes) {
        const routeKey = `${route.method} ${route.path}`;
        const existingOwner = routeOwners.get(routeKey);
        if (existingOwner) {
          throw new ForgeError(
            `Route ${routeKey} is declared by both "${existingOwner}" and "${owner}" on ${group.label}`,
            'Each route on a shared gateway must belong to exactly one component.',
          );
        }
        routeOwners.set(routeKey, owner);

        if (route.path === '/') continue;
        let parent = '';
        for (const segment of route.path.slice(1).split('/')) {
          if (isVariableSegment(segment)) {
            const known = variableChildren.get(parent);
            if (known && known.segment !== segment) {
              const who =
                known.owner === owner
                  ? `Component "${owner}" declares`
                  : `Components "${known.owner}" and "${owner}" declare`;
              throw new ForgeError(
                `${who} sibling path variables "${known.segment}" and "${segment}" under "${parent || '/'}" on ${group.label}`,
                'API Gateway allows only one variable path part per resource level — use the same parameter name in every route (e.g. always {id}).',
              );
            }
            variableChildren.set(parent, { segment, owner });
          }
          parent = `${parent}/${segment}`;
        }
      }
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
    for (const component of [...domain.components, ...(domain.packComponents ?? [])]) {
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
    if (
      resolved.domain.name !== domain.name &&
      !(CROSS_DOMAIN_BINDABLE_TYPES as readonly string[]).includes(resolved.component.type)
    ) {
      throw new ForgeError(
        `Component "${domain.name}/${component.name}" binds across domains to "${binding.component}" (${resolved.component.type})`,
        'Only event-bus components accept cross-domain bindings; everything else stays domain-private so stacks remain independently deployable.',
      );
    }
    const allowed = bindableAccessFor(resolved.component.type);
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
