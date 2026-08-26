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
- Bindings are same-domain only (validated in `core/src/loader.ts`), with ONE
  exception: `event-bus` targets may be referenced cross-domain as
  "domain/name". Buses are addressed by deterministic physical name
  (`resourceNameFor` in core) — never introduce CloudFormation exports between
  domain stacks (an engine test asserts no `Fn::ImportValue`).
- `packages/cli` scaffolds from `packages/cli/templates/` (`{{var}}`
  placeholders; per-type file maps in `src/lib/scaffold.ts`).

## Generated lambdas: hexagonal + fusion

TS lambdas use `@fusion-framework/server` (user's friend's lib). Facts
verified against fusion 1.4.1 — recheck on upgrade:

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
