import type { z } from 'zod';
import { packComponentDefinition } from './packs';
import type { PackComponentSpec } from './packs';
import type {
  bindingAccessSchema,
  bindingSchema,
  componentManifestSchema,
  domainManifestSchema,
  environmentSchema,
  runtimeSchema,
  workspaceManifestSchema,
} from './schema';

export type WorkspaceManifest = z.infer<typeof workspaceManifestSchema>;
export type DomainManifest = z.infer<typeof domainManifestSchema>;
export type ComponentManifest = z.infer<typeof componentManifestSchema>;
export type Binding = z.infer<typeof bindingSchema>;
export type BindingAccess = z.infer<typeof bindingAccessSchema>;
export type EnvironmentSpec = z.infer<typeof environmentSchema>;
export type ComponentType = ComponentManifest['type'];

// Distribute the intersection over the union so `spec.type` narrowing still works.
type WithPath<T> = T extends unknown ? T & { path: string } : never;

/** A component manifest resolved against its directory on disk. */
export type ComponentSpec = WithPath<ComponentManifest>;

/** Built-in or pack-provided component. Pack specs carry a `pack` field. */
export type AnyComponentSpec = ComponentSpec | PackComponentSpec;

export interface DomainSpec extends DomainManifest {
  path: string;
  components: ComponentSpec[];
  /** Components provided by packs (forge.json "packs"); passive resources. */
  packComponents?: PackComponentSpec[];
}

export interface WorkspaceModel extends WorkspaceManifest {
  root: string;
  domains: DomainSpec[];
}

/** Component types that run code and may therefore declare bindings. */
export const FUNCTION_LIKE_TYPES: readonly ComponentType[] = ['function', 'http-api', 'queue-worker'];

/** Every built-in component type (packs add more at load time). */
export const BUILTIN_COMPONENT_TYPES: readonly ComponentType[] = [
  'function',
  'http-api',
  'queue-worker',
  'table',
  'bucket',
  'topic',
  'static-site',
  'event-bus',
  'gateway',
  'auth',
  'email',
];

/** Which access modes each bindable component type supports as a binding target. */
export const BINDABLE_ACCESS: Partial<Record<ComponentType, readonly BindingAccess[]>> = {
  table: ['read', 'write', 'read-write'],
  bucket: ['read', 'write', 'read-write'],
  'queue-worker': ['publish'],
  topic: ['publish'],
  'event-bus': ['publish'],
  email: ['send'],
};

/**
 * The only component type a binding may target across domains. Event buses are
 * referenced by deterministic name (no CloudFormation exports), so domains stay
 * independently deployable.
 */
export const CROSS_DOMAIN_BINDABLE_TYPES: readonly ComponentType[] = ['event-bus'];

/** Allowed binding access modes for a target type — built-in or pack-provided. */
export function bindableAccessFor(type: string): readonly BindingAccess[] | undefined {
  return BINDABLE_ACCESS[type as ComponentType] ?? packComponentDefinition(type)?.bindable?.access;
}

export type Runtime = z.infer<typeof runtimeSchema>;

/** Resolution order: component choice → workspace default → engine default. */
export function runtimeFor(
  model: Pick<WorkspaceManifest, 'defaults'>,
  config: { runtime?: Runtime } | undefined,
  engineDefault: Runtime,
): Runtime {
  return config?.runtime ?? model.defaults?.runtime ?? engineDefault;
}
