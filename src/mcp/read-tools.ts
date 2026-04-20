// context-ledger — mcp/read-tools
// MCP read tool registration: query_decisions.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { queryDecisions } from "../retrieval/index.js";

export function registerReadTools(server: McpServer, projectRoot: string): void {
  server.tool(
    "query_decisions",
    "Retrieve relevant decision records for a file path, query, or scope. Returns a decision pack with prior mistakes in scope (antipatterns surfaced first), active precedents, abandoned approaches, recently superseded decisions (same-scope on opt-in, cross-scope by default when the replacement is in scope), and pending inbox items.",
    {
      file_path: z.string().optional().describe("File path to derive scope from (primary entry point)"),
      query: z.string().optional().describe("Natural language query — triggers broad fallback if no file_path or scope"),
      scope_type: z.string().optional().describe("Explicit scope type (overrides file_path derivation)"),
      scope_id: z.string().optional().describe("Explicit scope identifier"),
      decision_kind: z.string().optional().describe("Soft filter by decision kind label"),
      tags: z.array(z.string()).optional().describe("Filter by tags (OR semantics)"),
      include_superseded: z.boolean().optional().describe("Include same-scope recently superseded decisions (default false). Cross-scope supersedes — where the replacement record's scope matches the query — surface regardless of this flag; use include_cross_scope_supersede to opt out of those."),
      include_unreviewed: z.boolean().optional().describe("Include unreviewed decisions (default false)"),
      include_feature_local: z.boolean().optional().describe("Include feature-local durability records (overrides the default file-path-match requirement). Default false."),
      include_cross_scope_supersede: z.boolean().optional().describe("Include cross-scope superseded records whose replacement is in the query scope. Default true — these are genealogy of the in-scope record, not stale history. Set false to suppress."),
      limit: z.number().int().optional().describe("Max results (default 20)"),
      offset: z.number().int().optional().describe("Pagination offset for truncated results (default 0)"),
    },
    { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    async (args) => {
      try {
        const pack = await queryDecisions(args, projectRoot);
        return { content: [{ type: "text" as const, text: JSON.stringify(pack, null, 2) }] };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Error: ${err.message}` }], isError: true };
      }
    },
  );
}
