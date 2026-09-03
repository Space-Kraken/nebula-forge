Do not include a Co-Authored-By line in commit messages.

# forge (modern-cloud-architecture-accelerator)

Angular-style CLI that scaffolds well-architected, domain-separated AWS
projects. pnpm monorepo, TypeScript project references, oclif CLI.

## Commands

- `pnpm install` / `pnpm run build` (tsc -b) / `pnpm test` (all packages)
- Single package: `pnpm --filter @forgecli/engine-cdk run test`
- Try the CLI locally: `node packages/cli/bin/run.js new demo --blueprint queue-processing --link`
  (`--link` wires `link:` deps to this checkout; generated app needs `pnpm install` inside it)

## Architecture (load-bearing rules)

- `packages/core` is the **cloud-agnostic model** (manifests, zod schemas,
  loader, `Engine` contract). It must never import CDK or AWS SDKs.
- `packages/engine-cdk` implements `Engine`: one `DomainStack` per domain,
  `builders.ts` per component type, `bindings.ts` turns declared bindings into
  least-privilege IAM grants + discovery env vars.
- Bindings are same-domain only (validated in `core/src/loader.ts`), with TWO
  cross-domain exceptions referenced as "domain/name": `event-bus` targets and
  `gateway` mounts (`http-api` config.mount). Both are addressed by
  deterministic physical name (`resourceNameFor` in core) — the gateway stack
  integrates mounted lambdas via ARNs built from Aws pseudo-parameters and
  explicit CfnPermissions. Never introduce CloudFormation exports between
  domain stacks (engine tests assert no `Fn::ImportValue`). Route validation
  runs per GATEWAY GROUP (loader `validateApiRoutes`): duplicates and sibling
  path variables are checked across every http-api mounted on the same
  gateway; mounted status routes are namespaced `/{module}/status`.
- `packages/engine-azure-tf` implements the same model for Azure by emitting
  **plain Terraform JSON** (no CDKTF): one root module per domain, RBAC role
  assignments + managed identities for bindings, Event Grid for events
  (cross-domain via deterministic names + data sources — never
  terraform_remote_state), esbuild-zipped Function Apps
  (`@azure/functions-core` stays external). Azure names that must be short
  and globally unique go through hashed helpers in its `names.ts`.
  `http-api`/`static-site` are rejected until fusion-azure/Front Door land.
- `packages/cli` scaffolds from `packages/cli/templates/` (`{{var}}`
  placeholders). Engine dispatch lives in `src/lib/engines/`: each adapter
  declares its workspace files, component templates, module test template and
  synth/diff/deploy toolchain (cdk vs terraform -chdir per domain). Shared
  templates in `templates/workspace/`, per-engine under `templates/engines/`.

## Generated lambdas: hexagonal, fusion optional

The hexagonal layout is the invariant; the framework is a per-component
`config.runtime` choice resolved component → forge.json defaults.runtime →
adapter defaultRuntime (aws: ts-fusion; azure: ts). Templates live under
`component/<type>/<runtime>/` and `component/endpoint/<runtime>/` (shared
endpoint test — both runtimes return the same response contract). The plain
`ts` http-api uses a forge-generated router with the SAME exact
`httpMethod + resource` matching, so engine and validations are
runtime-agnostic. `remove endpoint` parses both controller styles.

Fusion facts verified against fusion 1.4.1 — recheck on upgrade:

- HTTP routing is an exact `httpMethod + resource` match → engine emits
  API Gateway **REST (payload v1)** with one resource per route in
  `component.json`; controller decorators must mirror those routes, and the
  `@Controller('...')` route must be non-empty (empty string is ignored).
- DI requires explicit tokens (`@Executor()`, `@Inject('token')`) because
  esbuild does not emit decorator metadata.
- SQS workers use a forge-generated adapter returning `batchItemFailures`
  (fusion's listener pipeline swallows errors → would ack failed messages).

- Edge: a static-site's `config.api` serves a SAME-module gateway/unmounted
  http-api behind CloudFront at `/api/*` (HttpOrigin on restApiId + originPath
  stage + CloudFront Function stripping /api; static-site builds LAST in
  DomainStack for this). Same origin → no CORS. `config.media` mounts a
  same-module bucket at `/media/*` (S3+OAC origin, GET/HEAD, cached, prefix
  stripped; READ-only on purpose — LIST would expose the bucket listing at
  GET /media/). With api/media present the SPA fallback switches from
  CustomErrorResponses (distribution-wide → would mask API/media 404s as 200
  index.html) to a viewer-request function rewriting extensionless URIs. `config.cors` (gateway/
  unmounted http-api only) = preflight via defaultCorsPreflightOptions +
  `CORS_ORIGIN` env on the lambda (for MOUNTED apis the gateway's cors is
  resolved from the model and injected in the api's own stack); handler
  templates emit the response header. `config.domain` {name, zone:{id,name},
  environments?} = DNS-validated ACM cert + A/AAAA aliases — zone is explicit
  (no lookups), CloudFront domains require us-east-1 (checked at synth like
  WAF), api domains are regional DomainName + BasePathMapping.
- `auth` (Cognito User Pool + client) attaches to gateways/unmounted http-apis
  in the SAME module only (pool ids are not deterministic → colocated stack;
  auth builds first in DomainStack). Routes accept `public: true` to skip the
  authorizer (scaffolded status routes are public). Mounted apis inherit the
  gateway's authorizer and must not declare their own.

## Attachments (acoples)

Generation is attachment-aware: `generate component` prompts on a TTY
(`cli/src/lib/interactive.ts` gates on isTTY && !CI && !--no-interactive) and
mirrors every prompt with flags (`--bind`, `--attach`, `--subscribe`).
`cli/src/lib/attach.ts` edits EXISTING manifests (validate + rollback on
failure). The full lifecycle is covered: `attach`/`detach` manage couplings on
existing components (shared prompts in `cli/src/lib/coupling-prompts.ts`), and
`remove component|endpoint` (`cli/src/lib/remove.ts`) deletes pieces —
refusing while referrers exist (`findReferrers`), or cascading detaches with
--force so no dangling reference survives; destructive commands need a TTY
confirm or --yes. Endpoints: `generate endpoint` (`cli/src/lib/endpoints.ts`) adds the
API Gateway route to component.json AND the fusion controller/use case/test;
controllers register through a barrel (`src/infrastructure/controllers/index.ts`)
that forge regenerates from the directory listing — never patch user code
in place. `function` components may also declare `config.subscriptions`
(EventBridge rule → Lambda direct); queue-worker remains the recommended
target for reliable processing (retries + DLQ).

## Org naming + tags (forge.json "naming"/"tags"/"conventions")

`conventions` inherits the contract from a package (npm name or "./path",
createRequire like packs — see `core/src/conventions.ts`) exporting
{naming?, tags?}. With it set, inline naming/tags are a LOAD ERROR; explicit
deviations live under `overrides` (naming replaces whole, tags merge per
key) and surface as `model.warnings` — commands print them via
`BaseCommand.loadModel()` (all commands load through it, never bare
loadWorkspace). Version pin = the package's version in package.json;
bumping it is a migration event. The org declares the contract; forge
conforms. `naming.pattern` is a template
over the FIXED vocabulary {project}/{module}/{name}/{env} (exactly
resourceNameFor's dimensions — never add tokens); `separator` re-joins the
default dimensions. Resolution lives ONCE in `core/src/names.ts`: a
module-global pattern set by `configureNaming`, called by loadWorkspace AND
by both engine entry points from `model.naming` — engines/docs keep calling
`resourceNameFor(project, module, name, env)` untouched. Absent config = the
historic convention byte for byte (`defaultNamingPattern()` is the snapshot).
Names stay a pure function of the model (cross-domain addressing + collision
detection depend on it) — no per-resource overrides, ever. The loader renders
EVERY component name per environment and validates collisions, charset
(azure: lowercase; aws: [A-Za-z0-9_-]) and, when naming is configured,
length UNCONDITIONALLY for name-addressed resources (aws function-like 64,
event-bus 256; azure event-grid topic 50 — azure function apps are exempt,
globalName hashes them). Function names NEVER fall back silently (gateway
mounts build ARNs from them); decorative names (restApiName, tableName,
userPoolName — addressed by id/Ref) keep the omit-when-long fallback via
`decorativeName` in builders.ts and are DECLARED "autogenerated" in the
exported model. `tags` values render
{project}/{module}/{env} ({name} is per-resource → rejected); aws applies
them via `Tags.of(stack)`, azure via a TAGGABLE_TF_TYPES whitelist (role
assignments/queues accept none). Azure component names: the pattern feeds
`globalName('fn', [resourceNameFor(...)])` — the hashed helper still owns
shortness/uniqueness; domain-level shared infra (rg-/st/cos-/sb-) keeps its
internal hashed names in v1. `bindingEnvVarFor` and everything generated code
references is OUT of scope. Names are identity: changing `naming` on a
deployed workspace REPLACES resources (scaffolded README + AGENTS.md warn).

## Model export + capability manifests (`forge model --json`)

`core/src/export.ts` renders the versioned machine-readable contract
(schemaVersion 1; additive = same version, renames = bump). Physical-name
coverage is DECLARED: name-addressed resources export the rendered name,
everything else the literal "autogenerated" — never invent names. Capability
manifests (resource types per component type) live on the CLI ENGINE
ADAPTERS (`cli/src/lib/engines/*.ts`, `capabilities` field) — NOT in the
engine packages, so the CLI never depends on aws-cdk-lib at runtime; the
engines are cli devDependencies only, for the MANDATORY anti-drift test
(`cli/test/capabilities-drift.test.ts`: declared types == types present in a
maximal real synth, both directions, both engines — a new builder resource
or a stale declaration fails there). `globalName`/`hashSuffix` moved to
core/names.ts (shared by engine-azure-tf and the azure adapter's
physicalNameFor) — engine-azure-tf re-exports them.

## Validation philosophy

Fail at generate/load time, never at deploy time. `core/src/routes.ts` is the
single route grammar (segment charset, whole-segment variables, greedy last);
the loader additionally rejects sibling path variables with different names,
duplicate subscriptions, FIFO workers with subscriptions, and physical-name
collisions. All manifest schemas are `.strict()` — never let zod silently
strip an unknown key, because that turns "accepted" config into config that
never takes effect. CLI commands validate flags (access enums, subscriber
types, attach consumers) BEFORE writing files, and roll the scaffold back if a
later step fails — a failed command must leave the workspace exactly as it
was.

## Living docs

`core/src/docs.ts` renders docs/architecture.md (Markdown + Mermaid) AND
AGENTS.md (`renderAgentGuide` — workspace rules + current architecture for AI
tools) from the model; `forge docs` writes both and every scaffolding command
regenerates them (`cli/src/lib/docs.ts`). The binding env-var naming lives
once in `core/src/names.ts` (`bindingEnvVarFor`, with a fallback to the pack
registry's `bindable.envVar`) and is shared by engine-cdk and docs — never
duplicate it.

## Extensibility: packs + extend.ts

- **Component packs** (`core/src/packs.ts`): npm packages / local files listed
  in forge.json `packs`, loaded by `loadPacks` (createRequire from workspace
  root — the registry is module-global and RESET on every load, so tests that
  bypass loadWorkspace must registerPack/resetPacks manually). A pack
  component is PASSIVE in v1: bindable target, no own bindings (loader
  rejects). Loader parses its config with the pack's zod schema; specs land in
  `domain.packComponents` (optional array, separate from `components` to avoid
  type ripple — narrow with `'pack' in spec`). Only aws-cdk has pack builders
  (`engines['aws-cdk']: AwsPackBuilder` → `{resource, grant?, bindingEnv?}`);
  engine-azure-tf rejects pack components. Scaffold templates support
  {{name}}/{{module}}/{{pascalName}}/{{screamingName}}. Example pack:
  `examples/forge-pack-secret/` (not a workspace package — plain JS,
  peerDeps on zod + aws-cdk-lib).
- **Escape hatch**: `domains/<module>/extend.ts|js`, executed at the end of
  each domain's synth (aws: `applyExtension` with {stack, model, domain,
  environment, components}; azure: {document, ...}). Loaded via esbuild
  `buildSync({bundle, packages:'external', write:false})` + `new Function`
  with `createRequire(file)` — works under node/tsx/vitest without
  precompiling. Keep extensions inside the domain stack; cross-stack refs
  stay forbidden.

## Conventions

- Package manager is pnpm (never npm); esbuild build scripts approved via
  `allowBuilds` in pnpm-workspace.yaml.
- `ForgeError(message, hint)` for every user-facing failure; the CLI's
  BaseCommand renders the hint.
- Engine tests assert synthesized CloudFormation via `aws-cdk-lib/assertions`
  (they bundle real fixture handlers, so they take a few seconds).
