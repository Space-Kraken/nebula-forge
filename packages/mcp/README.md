# @space-kraken/nebula-forge-mcp

MCP (Model Context Protocol) server exposing forge's workspace operations as
tools for agentic executors. The public contract is these tools — the
internal `cli/src/lib` APIs stay free to change.

Every tool takes an explicit `workspaceRoot`, always runs the
**non-interactive** path (nothing can hang on a prompt), returns structured
JSON (what was created/edited, what validations ran) and surfaces
`ForgeError`s as message + actionable hint. Mutating tools keep the CLI's
transactionality: a failed call leaves the workspace exactly as it was.

## Tools

| Tool | What it does |
|---|---|
| `list_model` | The versioned model export (same as `forge model --json`) |
| `validate_workspace` | Full load + validation verdict, with warnings |
| `generate_component` | Create a component with bind/attach/subscribe couplings |
| `generate_endpoint` | Route + controller + use case + test, in sync |
| `attach` / `detach` | Manage couplings on existing components |
| `remove_component` | Refuses while referenced; `force` cascades detaches |
| `regenerate_docs` | Rewrite docs/architecture.md and AGENTS.md |

## Local registration (not published yet)

Build the monorepo (`pnpm install && pnpm run build`), then register the
stdio server in your MCP client:

```bash
# Claude Code
claude mcp add forge -- node <checkout>/packages/mcp/bin/run.js
```

```jsonc
// generic mcpServers config
{
  "mcpServers": {
    "forge": { "command": "node", "args": ["<checkout>/packages/mcp/bin/run.js"] }
  }
}
```

Point tools at a workspace by passing its absolute path as `workspaceRoot`.
