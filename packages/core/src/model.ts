import type { z } from 'zod';
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

export interface DomainSpec extends DomainManifest {
  path: string;
  components: ComponentSpec[];
}

export interface WorkspaceModel extends WorkspaceManifest {
  root: string;
  domains: DomainSpec[];
}

/** Component types that run code and may therefore declare bindings. */
export const FUNCTION_LIKE_TYPES: readonly ComponentType[] = ['function', 'http-api', 'queue-worker'];

/** Which access modes each bindable component type supports as a binding target. */
export const BINDABLE_ACCESS: Partial<Record<ComponentType, readonly BindingAccess[]>> = {
  table: ['read', 'write', 'read-write'],
  bucket: ['read', 'write', 'read-write'],
  'queue-worker': ['publish'],
  topic: ['publish'],
  'event-bus': ['publish'],
};

/**
 * The only component type a binding may target across domains. Event buses are
 * referenced by deterministic name (no CloudFormation exports), so domains stay
 * independently deployable.
 */
export const CROSS_DOMAIN_BINDABLE_TYPES: readonly ComponentType[] = ['event-bus'];

export type Runtime = z.infer<typeof runtimeSchema>;

/** Resolution order: component choice → workspace default → engine default. */
export function runtimeFor(
  model: Pick<WorkspaceManifest, 'defaults'>,
  config: { runtime?: Runtime } | undefined,
  engineDefault: Runtime,
): Runtime {
  return config?.runtime ?? model.defaults?.runtime ?? engineDefault;
}
