#!/usr/bin/env node
// context-ledger-mcp — standalone MCP server bin entry
import { startMcpServer } from "./mcp-server.js";

const projectRoot = process.env.CONTEXT_LEDGER_PROJECT_ROOT ?? process.cwd();
startMcpServer(projectRoot).catch((error) => {
  console.error("[context-ledger] Fatal error:", error);
  process.exit(1);
});
