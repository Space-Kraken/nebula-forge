# @space-kraken/nebula-forge-engine-azure-tf

The Azure synthesis engine for [Nebula Forge]: emits **plain Terraform JSON**
(no CDKTF) — one root module per domain with independent state, managed
identities + least-privilege RBAC from declared bindings, Event Grid for
cross-domain events by deterministic name, and esbuild-packaged Function
Apps.

Generated Azure workspaces depend on it directly; you normally don't install
it by hand — start from
[`@space-kraken/nebula-forge`](https://www.npmjs.com/package/@space-kraken/nebula-forge).

[Nebula Forge]: https://github.com/Space-Kraken/nebula-forge#readme
