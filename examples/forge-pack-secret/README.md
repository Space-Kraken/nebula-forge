# forge-pack-secret

Example **component pack** for [forge]. Packs are forge's modding system:
an npm package (or local file) that adds new component types to a workspace
without forking the CLI — think Steam Workshop for cloud components.

This pack adds a `secret` type backed by AWS Secrets Manager.

## Using it

```jsonc
// forge.json
{
  "packs": ["forge-pack-secret"]          // npm package…
  // "packs": ["./packs/secret/index.js"] // …or a local path while developing
}
```

```bash
pnpm add forge-pack-secret               # only for the npm form
forge generate component api-keys --type secret --module billing
forge attach billing/checkout --bind api-keys:read
```

The bound function receives `SECRET_API_KEYS_ARN` plus
`secretsmanager:GetSecretValue` on that secret — same least-privilege
binding model as the built-in types.

## Writing your own pack

A pack default-exports:

```js
module.exports = {
  name: 'my-pack',
  components: [{
    type: 'secret',            // new kebab-case type, must not collide
    configSchema: z.object({}).strict().default({}), // ALWAYS strict
    bindable: {                // omit for non-bindable resources
      access: ['read'],
      envVar: { prefix: 'SECRET', suffix: 'ARN' },
    },
    docs: { badge: '🔑' },     // used in docs/architecture.md diagrams
    scaffold: [{ path: 'README.md', content: '…{{name}}…' }],
    engines: {
      'aws-cdk': (scope, spec, ctx) => ({
        resource,                       // any construct
        grant: (grantee) => { … },      // called per binding
        bindingEnv: { VAR: value },     // injected into consumers
      }),
    },
  }],
};
```

Rules v1:

- Pack components are **passive**: they cannot declare bindings of their own
  (others bind *to* them). The loader enforces this.
- `aws-cdk` is the only engine with pack builders today; the azure-terraform
  engine rejects workspaces that use pack components.
- Scaffold templates support `{{name}}`, `{{module}}`, `{{pascalName}}` and
  `{{screamingName}}`.
- Declare `aws-cdk-lib` and `zod` as **peerDependencies** so your constructs
  share the workspace's versions.

[forge]: https://github.com/Space-Kraken/forge
