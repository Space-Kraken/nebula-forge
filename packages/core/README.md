# @space-kraken/nebula-forge-core

The cloud-agnostic architecture model behind [Nebula Forge]: manifests, zod
validation, the workspace loader, naming/tag conventions, the model export
and the `Engine` contract. It never imports CDK or cloud SDKs — engines
implement the contract.

You normally don't install this directly: it comes with
[`@space-kraken/nebula-forge`](https://www.npmjs.com/package/@space-kraken/nebula-forge)
(the CLI) and with generated workspaces.

[Nebula Forge]: https://github.com/Space-Kraken/nebula-forge#readme
