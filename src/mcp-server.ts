// context-ledger — mcp-server
// MCP server entry point. Stdout is reserved for JSON-RPC — all diagnostics use console.error.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerReadTools, registerWriteTools } from "./mcp/index.js";

export async function startMcpServer(projectRoot: string): Promise<void> {
  const server = new McpServer({
    name: "context-ledger",
    version: "0.1.0",
  });

  registerReadTools(server, projectRoot);
  registerWriteTools(server, projectRoot);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[context-ledger] MCP server running on stdio");
}
