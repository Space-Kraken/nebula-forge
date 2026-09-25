# forge-conventions-adapter

Example **conventions adapter** for [forge]. An organization keeps its cloud
standards in a package of its own (`index.js` here: its own naming
dimensions, its own tag scheme, its landing-zone description) that other
tooling consumes too. forge does not read that vocabulary — a small adapter
(`forge.js`) maps it onto forge's contract, and forge validates the result.

This is the compatibility seam: forge's contract stays small and versioned,
and every org writes its mapping as code, next to its standards.

## Using it

```jsonc
// forge.json
{
  "conventions": "acme-cloud-standards/forge"      // npm package subpath…
  // "conventions": "./standards/forge.js"          // …or a local path while developing
}
```

```bash
forge new acme-shop --conventions acme-cloud-standards/forge@0.1.0
# or, in an existing workspace:
pnpm add -D acme-cloud-standards@0.1.0   # then add the key to forge.json
forge docs                               # names/tags now follow the standards
```

With `conventions` set, inline `naming`, `tags` and `environments.<env>.deploy`
in forge.json are load errors; deliberate deviations go under `overrides`
and load with a visible warning.

## What an adapter is

A module whose default export is a function `(ctx) => contract`:

```ts
interface ConventionsContext {
  root: string;                  // workspace root (org config files are read from here)
  name: string;                  // forge.json "name"
  engine: 'aws-cdk' | 'azure-terraform';
  environments: Record<string, { account?: string; region: string }>;  // forge.json, without deploy
  forge: { version: string; conventionsSchemaVersion: 1 };
}

interface Contract {
  schemaVersion?: 1;
  naming?: { pattern?: string; separator?: string };   // tokens: {project} {module} {name} {env}
  tags?: { builtin?: false | { app?, domain?, environment? } } & Record<string, string>;  // values: {project} {module} {env}
  environments?: Record<string, { deploy?: { qualifier?, permissionsBoundary?, executionPolicies? } }>;
}
```

Rules forge enforces at load time (never at deploy):

- Synchronous and deterministic: same `ctx`, same contract. No network, no
  `process.cwd()`, no environment variables.
- `naming.pattern` only uses forge's four tokens. Mapping composes an org
  dimension INTO them (e.g. `{app}` → `{project}`); it never adds one. A
  dimension forge does not model (client, region) is folded into the
  workspace `name`.
- Throwing is the right way to reject a workspace (missing org config, a
  `name` that does not match the org's rule). forge surfaces the message.
- `schemaVersion` pins the contract the adapter targets; a mismatch fails
  loudly instead of silently ignoring keys.

Unit-test the adapter without forge:

```js
const { validateConventions } = require('@space-kraken/nebula-forge-core');
const adapter = require('acme-cloud-standards/forge');
const contract = adapter({ root: '/ws', name: 'acme-shop', engine: 'aws-cdk',
  environments: { dev: { account: '111122223333', region: 'us-east-1' } },
  forge: { version: '0.1.0', conventionsSchemaVersion: 1 } });
validateConventions(contract);   // throws a ForgeError on an invalid shape
```

[forge]: https://github.com/space-kraken/nebula-forge
