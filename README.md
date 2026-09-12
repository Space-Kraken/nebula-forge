# Nebula Forge

An Angular-style CLI for building well-architected AWS solutions without
being an architect. The CLI owns the structure, the organization and the
infrastructure best practices; your team focuses on business logic.

```bash
forge new my-app --blueprint queue-processing
cd my-app
forge generate module payments
forge generate component api --module payments --type http-api
forge test payments
forge deploy payments --env dev
```

📖 **[User guide](docs/guia-de-uso.md)** *(Spanish)* — the mental model
(workspace → modules → components → couplings), the full workflow and the
conventions.
🔧 **[Local development](docs/desarrollo-local.md)** *(Spanish)* — running
forge from the checkout, `--link` workspaces and the test loop.
📚 **[CLI reference](docs/referencia-cli.md)** *(Spanish)* — every command,
every flag, aliases (`g m`, `g c`, `g e`) and the cheat sheet.

## Why it exists

- Not everyone on a team has deep AWS architecture skills: excellent backend
  developers end up building tricky or poorly scalable solutions.
- Monolithic mega-stacks force you to test and deploy the whole system to
  change one small thing. forge separates **one stack per business domain**:
  each module is tested and deployed independently.
- Convention over configuration, like Angular: `new` and `generate` produce
  the right structure; nobody has to decide where things go.

## Concepts

| Concept | What it is | On AWS |
|---|---|---|
| **Workspace** | The project (`forge.json`: engine + environments) | — |
| **Module (domain)** | A business domain, isolated and deployable | 1 CloudFormation stack per environment |
| **Component** | A piece of architecture inside the module | `http-api`, `queue-worker`, `function`, `table`, `bucket`, `topic`, `static-site`, `event-bus`, `gateway`, `auth`, `email` |
| **Binding** | A declared dependency between components | Least-privilege IAM + discovery env vars (`TABLE_X_NAME`, `QUEUE_X_URL`) |
| **Blueprint** | A complete reference architecture | `serverless-api`, `queue-processing`, `scheduled-tasks`, `web-app`, `event-driven` |

Bindings **never cross domains**, with a single exception: `event-bus`
components (EventBridge). One domain publishes to `other-domain/bus` and a
`queue-worker` (or a `function`, for lightweight reactions without a DLQ)
subscribes via `subscriptions` in its manifest — the bus is referenced by
**deterministic name**, with no CloudFormation exports, so every stack keeps
deploying on its own. `static-site` ships a private S3 bucket + CloudFront
(SPA fallback, optional WAF, custom domain with ACM + Route53, and
`config.api` to serve the module's API behind the same distribution at
`/api/*` — same origin, no CORS). Gateways and http-apis accept explicit
CORS and a regional custom domain when external origins genuinely exist.

The API convention is **one Lambda per domain**: one `http-api` component
per module, with fusion routing that domain's controllers inside the Lambda
— which is why the Lambdas are hexagonal. Want a single API for the whole
project? Create a shared `gateway` and mount the `http-api`s with `--mount
platform/edge`: the gateway publishes the union of routes, integrating each
Lambda by deterministic name (1 API for N domains, N APIs, or a mix).

### Best practices built in

Every component leaves the factory with what an architect would demand:
queues with DLQs and partial-batch retries (`reportBatchItemFailures`),
on-demand DynamoDB with point-in-time recovery, encrypted/blocked/SSL-only
S3, X-Ray enabled, ARM64 Lambdas on Node 24, stateful-resource retention in
production and app/domain/environment tags on everything.

### Lambdas: hexagonal + fusion

Generated TypeScript Lambdas follow **hexagonal architecture** on
[@fusion-framework/server](https://github.com/acyclicstudent/fusion-server):

- `src/handler.ts` — composition root (wiring only)
- `src/application/` — use cases (`@UseCase()` + `UCExecutor`): the business logic
- `src/domain/ports/` — ports (interfaces) the business logic depends on
- `src/infrastructure/` — adapters: inbound controllers/handlers, outbound repositories

Technical notes (verified against fusion 1.4.1):
- fusion routes HTTP by exact `httpMethod + resource` match → the engine
  emits **API Gateway REST (payload v1)** with one resource per route
  declared in `component.json`.
- Injection must use explicit tokens (`@Executor()`, `@Inject('token')`):
  esbuild does not emit decorator metadata.
- SQS workers use a forge-generated adapter (not fusion's listener pipeline,
  which captures errors and would ack failed messages); the logic still
  lives in fusion use cases.

### Inferred couplings

When you generate a resource on a terminal, the CLI looks at the workspace
and **infers what it can couple to**: creating a table asks which components
will use it (editing the consumer's manifest), creating a lambda asks what
resources it connects to, and creating a worker or function offers to
subscribe it to an event bus. Every prompt has an equivalent flag
(`--attach api:read-write`, `--subscribe platform/events:source=orders`), so
nothing prompts in CI. Endpoints attach through `forge generate endpoint`:
controllers live in a generated barrel
(`src/infrastructure/controllers/index.ts`) that forge rewrites — it never
patches your code in place.

The full lifecycle is managed after creation too: `forge attach` /
`forge detach` add or remove couplings on existing components (with
validation and rollback over the manifests), and
`forge remove component|endpoint` deletes pieces — refusing while other
components use them, or detaching them first with `--force`, so a dangling
reference can never survive.

### Living documentation (for humans and for AIs)

`forge docs` generates `docs/architecture.md` with a Mermaid diagram of the
workspace (domains as subgraphs, typed components, bindings as arrows) and a
per-module table with its injected env vars — plus `AGENTS.md` at the root:
the workspace rules, the current architecture and the command cheat sheet in
the format Claude Code, Cursor and Copilot read, so any AI opened on the
project knows how to work on it without breaking it. Both regenerate
automatically on every `forge new` / `forge generate`, so they never lie.
Mermaid renders natively on GitHub/GitLab.

### Extensibility: escape hatch and packs

When forge doesn't model something, you don't abandon forge:
`domains/<module>/extend.ts` receives the domain's stack (or the Terraform
document on Azure) and you write raw CDK/TF there, inside the same domain
boundaries. And when that something is reusable, it becomes a **component
pack**: an npm package that adds new component types (`forge.json` →
`"packs": [...]`) with a validated schema, least-privilege bindings,
scaffolding and presence in the docs — like the Steam Workshop, but for
architecture. Complete example in `examples/forge-pack-secret/`.

### Per-domain testing

Components that run code (`function`, `http-api`, `queue-worker`) are born
with a unit test, and every module with a snapshot test of its
CloudFormation template. `forge test payments` runs only that domain; when
you change infrastructure on purpose, `forge test payments --update` accepts
the new snapshot.

## Multi-cloud: Azure (beta)

Same model, different engine: `forge new my-app --engine azure-terraform`
generates a workspace whose `forge synth/diff/deploy` produces **plain
Terraform JSON** (one root module per domain, independent state) and drives
the `terraform` binary for you — your team never writes or reads HCL.

| Model | Azure |
|---|---|
| module | Resource Group + its own Terraform state |
| `function` / `queue-worker` | Function Apps (Node 20, forge-packaged zip) / Service Bus queue + DLQ |
| `table` / `bucket` / `topic` | Serverless Cosmos DB / Blob container / Service Bus topic |
| `event-bus` | Event Grid topic by deterministic name (cross-domain with no shared state) |
| bindings | Managed identity + least-privilege RBAC + discovery app settings |

Not on Azure yet: `http-api` (arrives with fusion-azure) and `static-site`
(Front Door) — the CLI rejects them with a clear error. For teams:
`forge bootstrap` provisions the remote state backend (deterministic storage
account), records it in `forge.json` and migrates local state.

## Corporate platform integration

forge is not just a standalone generator — it is designed to operate INSIDE
a corporate framework, where the platform defines the contract and forge
conforms:

- **Inherited conventions**: `"conventions"` in forge.json points at an
  org-owned npm package exporting `{ naming, tags }` — the rule lives once;
  deviating requires an explicit `overrides` block that loads with a
  warning. Bumping the package version is a migration event.
- **Exportable model**: `forge model --json` emits the versioned contract
  (rendered physical names or `"autogenerated"`, resolved tags, a capability
  manifest per component) for IAM policy generators and external validators
  — offline, credential-free, with an anti-drift test against the real
  CloudFormation/Terraform output.
- **Deployment identity**: `environments.<env>.deploy` points at the landing
  zone's `cdk bootstrap` (qualifier, permissions boundary, execution
  policies). forge never touches credentials.
- **Controllable builtin tags**: `tags.builtin` renames or disables
  `forge:app/domain/environment` when the platform has its own scheme.
- **MCP server** (`@space-kraken/nebula-forge-mcp`): the workspace
  operations as tools for agentic executors — non-interactive,
  transactional, with forge's actionable errors.

## Monorepo structure

```
packages/
  core/             Cloud-agnostic model: manifests, validation (zod), loader, Engine contract
  engine-cdk/       AWS CDK engine: DomainStack, per-type builders, bindings → IAM
  engine-azure-tf/  Azure engine: plain Terraform JSON, RBAC, Event Grid, Functions packaging
  blueprints/       Reference architectures
  cli/              oclif: new, generate, attach/detach/remove, docs, test, synth, diff, deploy, model
  mcp/              MCP server: forge's operations as tools for agents
```

`core` knows nothing about CDK: it defines the model (workspace → domains →
components → bindings) and the `Engine` contract. `engine-cdk` is the first
implementation; other engines (other clouds) implement the same contract —
that is the multi-cloud path.

## Development

```bash
pnpm install
pnpm run build        # tsc -b with project references
pnpm test             # tests across all packages

# Try the CLI against the local checkout (link: deps)
node packages/cli/bin/run.js new demo --blueprint queue-processing --link
```

## Commands

| Command | Description |
|---|---|
| `forge new <name> [--blueprint <id>] [--engine …] [--profile <aws>\|--subscription <az>]` | Create a workspace; prompts for credentials on a terminal (empty = default) |
| `forge blueprints` | List the reference architectures |
| `forge generate module <name>` | New domain (independent stack) |
| `forge generate component <n> -m <mod> -t <type>` | New component; on a terminal it **infers the couplings and asks** (what it connects to, who uses it, which bus it subscribes to). CI flags: `--bind`, `--attach`, `--subscribe`, `--no-interactive` |
| `forge generate endpoint <n> -m <mod> [--method GET --route /x/{id}]` | Attach an endpoint to the domain's Lambda: API Gateway route + fusion controller + use case + test, always in sync |
| `forge attach <comp> -m <mod> [--bind t:access] [--subscribe bus:…]` | Attach couplings to an **existing** component (interactive without flags) |
| `forge detach <comp> -m <mod> [--bind t] [--subscribe bus]` | Detach bindings/subscriptions (interactive: checkbox of current couplings) |
| `forge remove module\|component\|endpoint <n> [--force]` | Remove pieces; refuses while something uses them (`--force` detaches first) |
| `forge remove endpoint <n> -m <mod>` | Remove an endpoint: route + controller + use case + test + barrel |
| `forge list` | Show the workspace architecture |
| `forge docs [--print]` | Generate `docs/architecture.md` (Mermaid diagram + tables); auto-regenerates on every `new`/`generate` |
| `forge model --json [--env <e>]` | Export the versioned machine-readable model (names, tags, capabilities) for external tooling |
| `forge test [module]` | Unit + infrastructure tests |
| `forge synth [module] [-e env]` | Generate CloudFormation |
| `forge diff [module] [-e env]` | What a deploy would change |
| `forge deploy <module> [-e env]` | Deploy one domain (`--all` for everything, explicitly) |
| `forge bootstrap [-e env]` | Prepare the environment: `cdk bootstrap` (AWS) or remote state backend + migration (Azure). Idempotent |

## Roadmap

- [x] Publish `@space-kraken/nebula-forge-*` on npm (0.1.x beta, trusted publishing + provenance)
- [ ] Azure 1b: `http-api` with fusion-azure, `static-site` with Front Door, Entra External ID, ACS email
- [ ] Frontend in a repo separate from the backend (multi-repo: independent front/back workspaces that reference each other) — design pending
- [ ] `state-machine` (Step Functions) for orchestration
- [ ] `service` (ECS) for microservices where Lambda isn't enough, plus custom VPC support
- [ ] Typed contracts for cross-domain events
- [ ] Generated CI/CD pipeline (per-domain deploys)
- [ ] More engines (other clouds) on the same model
