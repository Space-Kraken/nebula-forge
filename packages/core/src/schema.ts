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
    /** AWS named profile used by the toolchain for this environment (aws-cdk only). */
    profile: z.string().optional(),
    /** Marks the environment as production (stateful resources are retained on delete). Defaults to name === "prod". */
    production: z.boolean().optional(),
    /**
     * Deployment identity (aws-cdk only): points synth/deploy at a CUSTOM
     * cdk bootstrap — the landing-zone contract. forge never touches
     * credentials; CDK assumes the bootstrap's roles as always.
     */
    deploy: z
      .object({
        /** Bootstrap qualifier (also configured on the synthesizer so deploy assumes THAT bootstrap's roles). */
        qualifier: z
          .string()
          .regex(/^[a-z0-9-]{1,10}$/, 'up to 10 chars: lowercase letters, digits, hyphens')
          .optional(),
        /** NAME of the managed policy used as permissions boundary for the bootstrap roles. */
        permissionsBoundary: z.string().min(1).optional(),
        /** Managed policy ARNs granted to the CloudFormation execution role. */
        executionPolicies: z.array(z.string().min(1)).nonempty().optional(),
      })
      .strict()
      .optional(),
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

export const runtimeSchema = z.enum(['ts-fusion', 'ts']);

/**
 * Org-defined naming convention. pattern: template over {project},
 * {module}, {name}, {env}; separator joins the default dimensions when no
 * pattern is given. Absent = forge's historic convention, byte for byte.
 * WARNING: names are identity — changing this on a DEPLOYED workspace
 * replaces resources (tables/buckets lose data).
 */
export const namingSchema = z
  .object({
    pattern: z.string().min(1).optional(),
    separator: z.string().min(1).max(5).optional(),
  })
  .strict();

/**
 * Tags applied to every resource by both engines. Values accept {project},
 * {module} and {env}.
 */
export const tagsSchema = z.record(z.string().min(1), z.string().min(1));

/** What a conventions package (forge.json "conventions") exports. */
export const conventionsSchema = z
  .object({
    naming: namingSchema.optional(),
    tags: tagsSchema.optional(),
  })
  .strict();

export const workspaceManifestSchema = z
  .object({
    name: nameSchema,
    engine: z.enum(['aws-cdk', 'azure-terraform']),
    defaultEnvironment: z.string(),
    environments: z.record(environmentSchema),
    /** Workspace-wide defaults applied when a component does not choose. */
    defaults: z
      .object({
        runtime: runtimeSchema.optional(),
      })
      .strict()
      .optional(),
    /** Component packs: npm package names or relative paths ("./packs/x"). */
    packs: z.array(z.string()).optional(),
    /**
     * Inherited org conventions: an npm package name or local path (same
     * resolution as packs) exporting { naming?, tags? }. With this set,
     * inline naming/tags are a LOAD ERROR — deviations go under "overrides",
     * which loads with a visible warning. The contract's version pin is the
     * package's version in package.json: bumping it is a MIGRATION EVENT
     * (names are identity), not a casual update.
     */
    conventions: z.string().min(1).optional(),
    /** Explicit, greppable deviations from the inherited conventions. */
    overrides: z
      .object({
        naming: namingSchema.optional(),
        tags: tagsSchema.optional(),
      })
      .strict()
      .optional(),
    naming: namingSchema.optional(),
    tags: tagsSchema.optional(),
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

export const bindingAccessSchema = z.enum(['read', 'write', 'read-write', 'publish', 'send']);

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
   * Handler flavor: 'ts-fusion' (hexagonal TypeScript on
   * @fusion-framework/server) or 'ts' (plain hexagonal TypeScript, no
   * framework). Unset = workspace default, then the engine's default. The
   * hexagonal layout is the invariant; the framework is optional.
   */
  runtime: runtimeSchema.optional(),
});

const RATE_UNITS = ['minute', 'minutes', 'hour', 'hours', 'day', 'days'];

/**
 * EventBridge schedule grammar, checked at load time — a typo'd expression
 * must fail here, never in the middle of a deploy.
 */
export function scheduleIssue(expression: string): string | undefined {
  const rate = /^rate\((\d+) ([a-z]+)\)$/.exec(expression);
  if (rate) {
    const value = Number(rate[1]);
    const unit = rate[2];
    if (value < 1 || !RATE_UNITS.includes(unit)) {
      return 'rate() takes a positive number and a unit: minute(s), hour(s) or day(s)';
    }
    if (value === 1 && unit.endsWith('s')) return `rate(1 …) uses the singular unit: "rate(1 ${unit.slice(0, -1)})"`;
    if (value > 1 && !unit.endsWith('s')) return `rate(${value} …) uses the plural unit: "rate(${value} ${unit}s)"`;
    return undefined;
  }
  const cron = /^cron\(([^)]*)\)$/.exec(expression);
  if (cron) {
    const fields = cron[1].trim().split(/\s+/);
    if (fields.length !== 6) {
      return `cron() takes 6 fields (minute hour day-of-month month day-of-week year), got ${fields.length} — unix cron has 5, EventBridge adds the year`;
    }
    if (fields.some((field) => !/^[A-Za-z0-9,*/?#LW-]+$/.test(field))) {
      return 'cron() has an invalid character in one of its fields';
    }
    if (fields[2] !== '?' && fields[4] !== '?') {
      return 'EventBridge requires "?" in day-of-month or day-of-week (both cannot carry a value)';
    }
    return undefined;
  }
  return 'expected "rate(N unit)" or "cron(m h dom mon dow y)"';
}

export const scheduleSchema = z.string().superRefine((expression, ctx) => {
  const issue = scheduleIssue(expression);
  if (issue) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Invalid schedule "${expression}": ${issue}. Examples: rate(5 minutes), rate(1 hour), cron(0 12 * * ? *)`,
    });
  }
});

export const functionConfigSchema = functionBaseConfig
  .extend({
    /** EventBridge schedule expression, e.g. "rate(1 hour)" or "cron(0 12 * * ? *)". */
    schedule: scheduleSchema.optional(),
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
    /** Skip the API's authorizer for this route (e.g. health checks, webhooks). */
    public: z.boolean().optional(),
  })
  .strict();

/**
 * Custom domain: ACM certificate (DNS-validated) + Route53 alias records.
 * The hosted zone is EXPLICIT (id + name) — no account lookups at synth time,
 * so synthesis stays reproducible and credential-free.
 */
export const customDomainSchema = z
  .object({
    /** Fully qualified domain name, e.g. "portfolio.example.com". */
    name: z.string().min(1).regex(/^[a-z0-9.-]+$/, 'must be a lowercase DNS name'),
    /** The Route53 hosted zone the name lives in. */
    zone: z.object({ id: z.string().min(1), name: z.string().min(1) }).strict(),
    /**
     * Environments that get the domain (default: all). A DNS name can only
     * point at one deployment — restrict it (e.g. ["prod"]) when the
     * workspace has several environments.
     */
    environments: z.array(z.string().min(1)).nonempty().optional(),
  })
  .strict();

/** CORS: true = any origin (*), or an explicit origin allowlist. */
export const corsConfigSchema = z.union([
  z.literal(true),
  z.object({ origins: z.array(z.string().min(1)).nonempty() }).strict(),
]);

export type CustomDomainConfig = z.infer<typeof customDomainSchema>;
export type CorsConfig = z.infer<typeof corsConfigSchema>;

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
    /**
     * auth component (same module) protecting this API's routes. Only for
     * UNMOUNTED apis — a mounted api inherits the gateway's authorizer.
     */
    auth: nameSchema.optional(),
    /**
     * CORS for browser clients on OTHER origins. Prefer serving the API
     * behind a static-site (config.api) — same origin needs no CORS. Only
     * for UNMOUNTED apis; a mounted api inherits the gateway's cors.
     */
    cors: corsConfigSchema.optional(),
    /** Custom domain (regional). Only for UNMOUNTED apis. */
    domain: customDomainSchema.optional(),
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
    /**
     * gateway or (unmounted) http-api in the SAME module served behind this
     * distribution under /api/* — same origin, so the frontend needs no CORS,
     * and the execute-api URL is never exposed.
     */
    api: nameSchema.optional(),
    /**
     * bucket in the SAME module served behind this distribution under
     * /media/* (S3 origin + OAC, GET/HEAD only, cached). Upload through a
     * bound function with clean keys — the /media prefix is stripped.
     */
    media: nameSchema.optional(),
    /** Custom domain for the distribution (requires a us-east-1 environment). */
    domain: customDomainSchema.optional(),
  })
  .strict();

export const eventBusConfigSchema = z.object({}).strict();

/** The shared edge (API front door). */
export const gatewayConfigSchema = z
  .object({
    /**
     * auth component (same module) whose authorizer protects every route the
     * gateway publishes, except routes marked public. Identity pools are not
     * deterministic across accounts, so auth and gateway stay colocated.
     */
    auth: nameSchema.optional(),
    /** CORS for browser clients on other origins (applies to every mounted api). */
    cors: corsConfigSchema.optional(),
    /** Custom domain (regional) for the gateway. */
    domain: customDomainSchema.optional(),
  })
  .strict();

const EMAIL_ADDRESS_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const EMAIL_DOMAIN_PATTERN = /^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/i;

/** Outbound email (AWS: SES identity). */
export const emailConfigSchema = z
  .object({
    /** Verified sender: an address ("no-reply@app.com") or a whole domain ("app.com"). */
    identity: z
      .string()
      .refine((value) => EMAIL_ADDRESS_PATTERN.test(value) || EMAIL_DOMAIN_PATTERN.test(value), {
        message: 'must be an email address (no-reply@app.com) or a domain (app.com)',
      }),
  })
  .strict();

/** Identity provider (AWS: Cognito User Pool + client). */
export const authConfigSchema = z
  .object({
    /** Allow users to sign themselves up (default: only admins create users). */
    selfSignUp: z.boolean().default(false),
  })
  .strict();

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
  z.object({ ...componentBase, type: z.literal('auth'), config: authConfigSchema.default({}) }).strict(),
  z.object({ ...componentBase, type: z.literal('email'), config: emailConfigSchema }).strict(),
]);
