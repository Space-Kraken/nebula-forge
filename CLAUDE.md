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

`core/src/docs.ts` renders docs/architecture.md (Markdown + Mermaid) from the
model; `forge docs` writes it and every scaffolding command regenerates it
(`cli/src/lib/docs.ts`). The binding env-var naming lives once in
`core/src/names.ts` (`bindingEnvVarFor`) and is shared by engine-cdk and docs
— never duplicate it.

## Conventions

- Package manager is pnpm (never npm); esbuild build scripts approved via
  `allowBuilds` in pnpm-workspace.yaml.
- `ForgeError(message, hint)` for every user-facing failure; the CLI's
  BaseCommand renders the hint.
- Engine tests assert synthesized CloudFormation via `aws-cdk-lib/assertions`
  (they bundle real fixture handlers, so they take a few seconds).
