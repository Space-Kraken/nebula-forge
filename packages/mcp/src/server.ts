import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ForgeError } from '@forgecli/core';
import { FORGE_TOOLS } from './tools';

/**
 * Stdio MCP server. The public contract for agentic executors is these
 * tools — NOT the internal cli/src/lib APIs, which stay free to change.
 * Every tool takes an explicit workspaceRoot and runs the non-interactive
 * path; ForgeErrors surface as message + actionable hint.
 */
export function createServer(): McpServer {
  const server = new McpServer({ name: 'forge', version: '0.1.0' });
  for (const forgeTool of FORGE_TOOLS) {
    server.tool(forgeTool.name, forgeTool.description, forgeTool.schema, async (params: Record<string, unknown>) => {
      try {
        const result = forgeTool.run(params as never);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } catch (error) {
        const message =
          error instanceof ForgeError && error.hint
            ? `${error.message}\n↳ ${error.hint}`
            : (error as Error).message;
        return { content: [{ type: 'text' as const, text: message }], isError: true };
      }
    });
  }
  return server;
}

export async function startServer(): Promise<void> {
  await createServer().connect(new StdioServerTransport());
}
