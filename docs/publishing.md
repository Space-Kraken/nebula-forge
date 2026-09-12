# Publishing the beta (runbook)

Everything below `npm login` is prepared and rehearsed: package metadata
(`publishConfig.access: public`, repository/keywords/engines), LICENSE and
README inside every publishable tarball, and a full dress rehearsal — a
workspace generated WITHOUT `--link`, installed from the packed tarballs,
through `list → generate → test → synth → model --json`.

Published packages (all `0.1.0`): `@space-kraken/nebula-forge` (the CLI,
bin `forge`), `-core`, `-engine-cdk`, `-engine-azure-tf`, `-blueprints`.
`@space-kraken/nebula-forge-mcp` stays `private` on purpose.

## Steps

```bash
# 1. Clean gate
pnpm install && pnpm run build && pnpm test

# 2. Authenticate (owner of the space-kraken org)
npm login

# 3. Publish every public package (pnpm rewrites workspace:^ → ^0.1.0)
pnpm -r publish --access public

# 4. Anchor the release
git tag v0.1.0 && git push origin v0.1.0
# then create the GitHub release from the tag

# 5. Post-publish smoke test, in an empty folder OUTSIDE the checkout
pnpm dlx @space-kraken/nebula-forge new smoke --blueprint queue-processing --no-interactive
cd smoke && pnpm exec forge test && pnpm exec forge synth
```

Notes:

- `pnpm -r publish` skips private packages (root, mcp) automatically. If the
  tree has uncommitted changes it refuses — commit first (or pass
  `--no-git-checks` knowingly).
- Scoped packages REQUIRE `--access public` on first publish (also set via
  each package's `publishConfig`); without it npm rejects the publish.
- Version bumps: keep all `@space-kraken/nebula-forge-*` packages on the same
  version (`pnpm -r exec pnpm version <x.y.z>` or edit + commit), then
  repeat from step 1. `0.x` = beta semantics: breaking changes bump the
  minor.
- The generated-workspace dependency floor lives in
  `cli/src/lib/scaffold.ts` (`forgeDependency` → `^0.1.0`): raise it when a
  workspace starts depending on newer engine/core behavior.
