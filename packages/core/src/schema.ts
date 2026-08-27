import { z } from 'zod';
import { NAME_PATTERN } from './names';
import { routePathIssues } from './routes';

export const nameSchema = z
  .string()
  .regex(NAME_PATTERN, 'must be kebab-case: lowercase letters and digits separated by dashes');

// Every manifest schema is strict: an unknown key is a user mistake (a typo,
// or a field the component type does not support) and silently stripping it
// would make forge "accept" configuration that never takes effect.
export const environmentSchema = z
  .object({
    account: z.string().optional(),
    region: z.string(),
    /** Marks the environment as production (stateful resources are retained on delete). Defaults to name === "prod". */
    production: z.boolean().optional(),
    /**
     * Remote state backend, written by `forge bootstrap` (azure-terraform
     * engine; aws-cdk keeps state in CloudFormation and ignores it).
     */
    state: z
      .object({
        resourceGroup: z.string(),
        storageAccount: z.string(),
        container: z.string(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const workspaceManifestSchema = z
  .object({
    name: nameSchema,
    engine: z.enum(['aws-cdk', 'azure-terraform']),
    defaultEnvironment: z.string(),
    environments: z.record(environmentSchema),
  })
  .strict()
  .superRefine((manifest, ctx) => {
    if (!(manifest.defaultEnvironment in manifest.environments)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `defaultEnvironment "${manifest.defaultEnvironment}" is not declared in environments`,
      });
    }
  });

export const domainManifestSchema = z
  .object({
    name: nameSchema,
    description: z.string().optional(),
  })
  .strict();

export const bindingAccessSchema = z.enum(['read', 'write', 'read-write', 'publish']);

/** A component reference: "name" within the domain, or "domain/name" across domains. */
const COMPONENT_REF_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*(?:\/[a-z][a-z0-9]*(?:-[a-z0-9]+)*)?$/;

export const componentRefSchema = z
  .string()
  .regex(COMPONENT_REF_PATTERN, 'must be "component" or "domain/component" in kebab-case');

export const bindingSchema = z
  .object({
    component: componentRefSchema,
    access: bindingAccessSchema,
  })
  .strict();

export const subscriptionSchema = z
  .object({
    /** The event-bus to subscribe to: "name" (same domain) or "domain/name". */
    bus: componentRefSchema,
    pattern: z
      .object({
        source: z.array(z.string()).min(1).optional(),
        detailType: z.array(z.string()).min(1).optional(),
      })
      .strict()
      .refine((pattern) => pattern.source || pattern.detailType, {
        message: 'subscription pattern needs at least source or detailType',
      }),
  })
  .strict();

const functionBaseConfig = z.object({
  entry: z.string().default('src/handler.ts'),
  memoryMb: z.number().int().min(128).max(10240).default(256),
  timeoutSeconds: z.number().int().min(1).max(900).default(30),
  environment: z.record(z.string()).default({}),
  /**
   * Handler flavor. Today only 'ts-fusion' (hexagonal TypeScript on
   * @fusion-framework/server); a plain 'ts' runtime and other languages are
   * planned — the hexagonal layout is the invariant, the framework is not.
   */
  runtime: z.enum(['ts-fusion']).optional(),
});

export const functionConfigSchema = functionBaseConfig
  .extend({
    /** EventBridge schedule expression, e.g. "rate(1 hour)" or "cron(0 12 * * ? *)". */
    schedule: z.string().optional(),
    /**
     * EventBridge subscriptions delivered directly to this function. For
     * workloads that need retries and a DLQ, prefer a queue-worker.
     */
    subscriptions: z.array(subscriptionSchema).default([]),
  })
  .strict();

export const routeSchema = z
  .object({
    method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'ANY']),
    path: z.string().superRefine((path, ctx) => {
      for (const issue of routePathIssues(path)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: issue });
      }
    }),
  })
  .strict();

export const httpApiConfigSchema = functionBaseConfig
  .extend({
    routes: z
      .array(routeSchema)
      .min(1)
      .default([{ method: 'ANY', path: '/{proxy+}' }]),
    /**
     * Shared gateway this API mounts on ("name" or "domain/name"). When set,
     * the domain builds only its Lambda; the gateway publishes the routes.
     * Unset = the component provisions its own gateway (fully autonomous).
     */
    mount: componentRefSchema.optional(),
  })
  .strict();

export const queueWorkerConfigSchema = functionBaseConfig
  .extend({
    batchSize: z.number().int().min(1).max(10).default(10),
    /** Retries before a message lands in the dead-letter queue. */
    maxRetries: z.number().int().min(0).max(100).default(3),
    fifo: z.boolean().default(false),
    /** EventBridge subscriptions delivered into this worker's queue. */
    subscriptions: z.array(subscriptionSchema).default([]),
  })
  .strict();

const keySchema = z
  .object({
    name: z.string(),
    type: z.enum(['string', 'number', 'binary']).default('string'),
  })
  .strict();

export const tableConfigSchema = z
  .object({
    partitionKey: keySchema,
    sortKey: keySchema.optional(),
    timeToLiveAttribute: z.string().optional(),
  })
  .strict();

export const bucketConfigSchema = z
  .object({
    versioned: z.boolean().default(false),
  })
  .strict();

export const topicConfigSchema = z
  .object({
    fifo: z.boolean().default(false),
  })
  .strict();

export const staticSiteConfigSchema = z
  .object({
    /** Directory (relative to the component) with the built site to publish. */
    sourceDir: z.string().default('site'),
    /** Single-page app mode: serve index.html for 403/404 so client routing works. */
    spa: z.boolean().default(true),
    /** Put an AWS WAF (managed common rule set) in front of CloudFront. */
    waf: z.boolean().default(false),
  })
  .strict();

export const eventBusConfigSchema = z.object({}).strict();

/** The shared edge (API front door). Future: authorizer, custom domain. */
export const gatewayConfigSchema = z.object({}).strict();

const componentBase = {
  name: nameSchema,
  description: z.string().optional(),
  bindings: z.array(bindingSchema).default([]),
};

export const componentManifestSchema = z.discriminatedUnion('type', [
  z.object({ ...componentBase, type: z.literal('function'), config: functionConfigSchema.default({}) }).strict(),
  z.object({ ...componentBase, type: z.literal('http-api'), config: httpApiConfigSchema.default({}) }).strict(),
  z.object({ ...componentBase, type: z.literal('queue-worker'), config: queueWorkerConfigSchema.default({}) }).strict(),
  z.object({ ...componentBase, type: z.literal('table'), config: tableConfigSchema }).strict(),
  z.object({ ...componentBase, type: z.literal('bucket'), config: bucketConfigSchema.default({}) }).strict(),
  z.object({ ...componentBase, type: z.literal('topic'), config: topicConfigSchema.default({}) }).strict(),
  z.object({ ...componentBase, type: z.literal('static-site'), config: staticSiteConfigSchema.default({}) }).strict(),
  z.object({ ...componentBase, type: z.literal('event-bus'), config: eventBusConfigSchema.default({}) }).strict(),
  z.object({ ...componentBase, type: z.literal('gateway'), config: gatewayConfigSchema.default({}) }).strict(),
]);
