# @space-kraken/nebula-forge-engine-cdk

The AWS CDK synthesis engine for [Nebula Forge]: one CloudFormation stack per
business domain, per-type builders, least-privilege IAM from declared
bindings, and deterministic cross-domain addressing (EventBridge buses,
shared gateways) with zero CloudFormation exports.

Generated workspaces depend on it directly (`infra/app.ts`); you normally
don't install it by hand — start from
[`@space-kraken/nebula-forge`](https://www.npmjs.com/package/@space-kraken/nebula-forge).

[Nebula Forge]: https://github.com/Space-Kraken/nebula-forge#readme
