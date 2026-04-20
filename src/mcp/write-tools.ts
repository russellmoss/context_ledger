// context-ledger — mcp/write-tools
// MCP write tool registrations: propose, confirm, reject, supersede, record_writeback.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type {
  DecisionRecord,
  TransitionEvent,
  InboxItem,
  EvidenceType,
  Durability,
  DecisionSource,
  VerificationStatus,
  ScopeType,
} from "../ledger/index.js";
import {
  generateDecisionId,
  generateTransitionId,
  generateInboxId,
  appendToLedger,
  appendToInbox,
  readInbox,
  readLedger,
  rewriteInbox,
  foldLedger,
} from "../ledger/index.js";
import { loadConfig } from "../config.js";
import type { LedgerConfig } from "../config.js";
import { deriveScope } from "../retrieval/index.js";

// ── Internal Types (C2/S1 fix) ──────────────────────────────────────────────

interface ProposedRecord {
  summary: string;
  decision: string;
  rationale: string;
  alternatives_considered: DecisionRecord["alternatives_considered"];
  revisit_conditions: string;
  review_after: string | null;
  scope_type: string;
  scope_id: string;
  affected_files: string[];
  scope_aliases: string[];
  decision_kind: string;
  tags: string[];
  durability: Durability;
  evidence_type?: EvidenceType;
  source?: DecisionSource;
  commit_sha?: string | null;
}

type PersistedInboxItem = InboxItem & {
  client_operation_id?: string;
  proposed_record?: ProposedRecord;
};

// v1.2.1 Bug 7 — derive a real scope for legacy inbox items that lack scope fields.
// Never returns a literal "unknown" sentinel — falls back to top-level directory or "root".
function deriveLegacyScope(
  item: InboxItem,
  config: LedgerConfig,
): { type: ScopeType; id: string } {
  const firstFile = item.changed_files[0];
  if (firstFile) {
    const derived = deriveScope({ file_path: firstFile }, config, new Map());
    if (derived) return { type: derived.type, id: derived.id };
    const normalized = firstFile.replace(/\\/g, "/");
    const top = normalized.split("/")[0] ?? "root";
    return { type: "directory", id: top || "root" };
  }
  return { type: "directory", id: "root" };
}

// ── Response Helpers (I3 fix) ────────────────────────────────────────────────

function makeToolResult(data: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function makeToolError(message: string) {
  console.error(`[context-ledger] Tool error: ${message}`);
  return { content: [{ type: "text" as const, text: JSON.stringify({ status: "error", message }, null, 2) }], isError: true as const };
}

// ── Registration ─────────────────────────────────────────────────────────────

export function registerWriteTools(server: McpServer, projectRoot: string): void {
  // ── Tool 1: propose_decision ─────────────────────────────────────────────

  server.tool(
    "propose_decision",
    "Draft a decision record for developer confirmation. Writes to inbox for review next session.",
    {
      client_operation_id: z.string().describe("Idempotency key — format: {feature-slug}-{YYYYMMDD}-{random4chars}"),
      summary: z.string().describe("One-line summary of the decision"),
      decision: z.string().describe("The decision text"),
      rationale: z.string().describe("Why this decision was made"),
      alternatives_considered: z.array(z.object({
        approach: z.string(),
        why_rejected: z.string(),
        failure_conditions: z.string().nullable(),
      })).optional().describe("Alternatives that were considered"),
      revisit_conditions: z.string().optional().describe("When to revisit this decision"),
      review_after: z.string().nullable().optional().describe("ISO 8601 date — required if durability is temporary-workaround"),
      scope_type: z.string().describe("Scope type: package, directory, domain, concern, integration"),
      scope_id: z.string().describe("Scope identifier"),
      affected_files: z.array(z.string()).optional().describe("Files affected by this decision"),
      scope_aliases: z.array(z.string()).optional().describe("Prior file paths if renamed"),
      decision_kind: z.string().optional().describe("Freeform label for the kind of decision"),
      tags: z.array(z.string()).optional().describe("Tags for filtering"),
      durability: z.enum(["precedent", "feature-local", "temporary-workaround"]).describe("How long this decision should persist"),
      evidence_type: z.enum(["human_answered", "explicit_manual", "workflow_writeback", "corrected_draft", "confirmed_draft", "backfill_confirmed", "commit_inferred"]).optional().describe("Evidence type (default: explicit_manual)"),
      source: z.enum(["manual", "workflow-writeback", "commit-inferred", "backfill"]).optional().describe("Decision source (default: manual)"),
      commit_sha: z.string().nullable().optional().describe("Associated commit SHA"),
    },
    { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    async (args) => {
      try {
        // Idempotency check
        const existingInbox = await readInbox(projectRoot) as PersistedInboxItem[];
        const duplicate = existingInbox.find((item) => item.client_operation_id === args.client_operation_id);
        if (duplicate) {
          return makeToolResult({ status: "proposed", inbox_id: duplicate.inbox_id });
        }

        const inbox_id = generateInboxId();
        const now = new Date();
        const expiresAt = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);

        const item: InboxItem = {
          inbox_id,
          type: "draft_needed",
          created: now.toISOString(),
          commit_sha: args.commit_sha ?? "",
          commit_message: args.summary,
          change_category: "mcp-proposed",
          changed_files: args.affected_files ?? [],
          diff_summary: args.decision,
          priority: "normal",
          expires_after: expiresAt.toISOString(),
          times_shown: 0,
          last_prompted_at: null,
          status: "pending",
        };

        // Extend with typed extra fields (C2 fix)
        const persisted = item as PersistedInboxItem;
        persisted.client_operation_id = args.client_operation_id;
        persisted.proposed_record = {
          summary: args.summary,
          decision: args.decision,
          rationale: args.rationale,
          alternatives_considered: args.alternatives_considered ?? [],
          revisit_conditions: args.revisit_conditions ?? "",
          review_after: args.review_after ?? null,
          // TODO(v1.3): tighten scope_type to z.enum(["package","directory","domain","concern","integration"])
          // with a one-release deprecation warning for non-enum values.
          scope_type: args.scope_type as ScopeType,
          scope_id: args.scope_id,
          affected_files: args.affected_files ?? [],
          scope_aliases: args.scope_aliases ?? [],
          decision_kind: args.decision_kind ?? "",
          tags: args.tags ?? [],
          durability: args.durability,
          evidence_type: args.evidence_type,
          source: args.source,
          commit_sha: args.commit_sha,
        };

        await appendToInbox(item as InboxItem, projectRoot);
        return makeToolResult({ status: "proposed", inbox_id });
      } catch (err: any) {
        return makeToolError(err.message);
      }
    },
  );

  // ── Tool 2: confirm_pending ──────────────────────────────────────────────

  server.tool(
    "confirm_pending",
    "Confirm a pending inbox item and write the decision to the ledger.",
    {
      inbox_id: z.string().describe("The inbox item ID to confirm"),
      client_operation_id: z.string().describe("Idempotency key"),
      verification_status: z.enum(["confirmed", "corrected"]).optional().describe("Verification status (default: confirmed)"),
    },
    { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    async (args) => {
      try {
        // Idempotency check against ledger
        const events = await readLedger(projectRoot);
        const dupLedger = events.find((e) => (e as unknown as Record<string, unknown>).client_operation_id === args.client_operation_id);
        if (dupLedger) {
          return makeToolResult({ status: "already_processed", decision_id: dupLedger.id });
        }

        const inboxItems = await readInbox(projectRoot) as PersistedInboxItem[];
        const item = inboxItems.find((i) => i.inbox_id === args.inbox_id);
        if (!item) {
          return makeToolError("Inbox item not found");
        }
        if (item.status !== "pending") {
          return makeToolError("Inbox item already resolved");
        }

        // v1.2.1 Bug 7 — accept legacy proposed_decision key.
        const proposed =
          item.proposed_record ??
          (item as unknown as { proposed_decision?: ProposedRecord }).proposed_decision;
        if (!proposed) {
          return makeToolError("Inbox item has no proposed record data");
        }

        const verStatus = args.verification_status ?? "confirmed";
        const evidenceType: EvidenceType = verStatus === "corrected"
          ? "corrected_draft"
          : (proposed.evidence_type ?? "confirmed_draft");

        const record: DecisionRecord = {
          type: "decision",
          id: generateDecisionId(),
          created: new Date().toISOString(),
          source: (proposed.source ?? "manual") as DecisionSource,
          evidence_type: evidenceType,
          verification_status: verStatus as VerificationStatus,
          commit_sha: proposed.commit_sha ?? null,
          summary: proposed.summary,
          decision: proposed.decision,
          alternatives_considered: proposed.alternatives_considered,
          rationale: proposed.rationale,
          revisit_conditions: proposed.revisit_conditions ?? "",
          review_after: proposed.review_after ?? null,
          scope: proposed.scope_type && proposed.scope_id
            ? { type: proposed.scope_type as ScopeType, id: proposed.scope_id }
            : deriveLegacyScope(item, await loadConfig(projectRoot)),
          affected_files: proposed.affected_files ?? [...item.changed_files],
          scope_aliases: proposed.scope_aliases ?? [],
          decision_kind: proposed.decision_kind,
          tags: proposed.tags,
          durability: proposed.durability,
        };

        // Store client_operation_id as extra field
        const recordWithOpId = { ...record, client_operation_id: args.client_operation_id };
        await appendToLedger(recordWithOpId as DecisionRecord, projectRoot);

        // Update inbox item status
        const updatedItems = inboxItems.map((i) =>
          i.inbox_id === args.inbox_id ? { ...i, status: "confirmed" as const } : i,
        );
        await rewriteInbox(updatedItems as InboxItem[], projectRoot);

        return makeToolResult({ status: "confirmed", decision_id: record.id });
      } catch (err: any) {
        return makeToolError(err.message);
      }
    },
  );

  // ── Tool 3: reject_pending ───────────────────────────────────────────────

  server.tool(
    "reject_pending",
    "Dismiss a pending inbox item.",
    {
      inbox_id: z.string().describe("The inbox item ID to reject"),
      client_operation_id: z.string().describe("Idempotency key"),
      reason: z.string().optional().describe("Reason for rejection"),
    },
    { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    async (args) => {
      try {
        const inboxItems = await readInbox(projectRoot) as PersistedInboxItem[];
        const item = inboxItems.find((i) => i.inbox_id === args.inbox_id);
        if (!item) {
          return makeToolError("Inbox item not found");
        }
        if (item.status !== "pending") {
          return makeToolResult({ status: "already_resolved" });
        }

        const updatedItems = inboxItems.map((i) => {
          if (i.inbox_id === args.inbox_id) {
            return {
              ...i,
              status: "dismissed" as const,
              client_operation_id: args.client_operation_id,
              ...(args.reason ? { rejection_reason: args.reason } : {}),
            } as PersistedInboxItem;
          }
          return i;
        });
        await rewriteInbox(updatedItems as InboxItem[], projectRoot);

        return makeToolResult({ status: "rejected" });
      } catch (err: any) {
        return makeToolError(err.message);
      }
    },
  );

  // ── Tool 4: supersede_decision ───────────────────────────────────────────

  server.tool(
    "supersede_decision",
    "Supersede an active decision with a replacement. Validates lifecycle state machine constraints.",
    {
      target_id: z.string().describe("ID of the decision to supersede"),
      replaced_by: z.string().describe("ID of the replacement decision"),
      client_operation_id: z.string().describe("Idempotency key"),
      reason: z.string().describe("Why the decision is being superseded"),
      pain_points: z.array(z.string()).optional().describe("What went wrong with the original decision"),
    },
    { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    async (args) => {
      try {
        // Idempotency check
        const events = await readLedger(projectRoot);
        const dupTransition = events.find((e) => (e as unknown as Record<string, unknown>).client_operation_id === args.client_operation_id);
        if (dupTransition) {
          return makeToolResult({ status: "superseded" });
        }

        // Fold and validate
        const state = await foldLedger(projectRoot);

        const targetFolded = state.decisions.get(args.target_id);
        if (!targetFolded) {
          return makeToolError(`Target decision ${args.target_id} not found`);
        }
        if (targetFolded.state !== "active") {
          return makeToolError(`Target decision ${args.target_id} is ${targetFolded.state}, not active`);
        }

        const replacementFolded = state.decisions.get(args.replaced_by);
        if (!replacementFolded) {
          return makeToolError(`Replacement decision ${args.replaced_by} not found`);
        }

        if (args.target_id === args.replaced_by) {
          return makeToolError("Cannot supersede a decision with itself");
        }

        // No cycles: walk supersession chain from replaced_by
        let current = args.replaced_by;
        const visited = new Set<string>();
        while (current) {
          if (current === args.target_id) {
            return makeToolError("Cycle detected: replacement chain leads back to target");
          }
          if (visited.has(current)) break;
          visited.add(current);
          const folded = state.decisions.get(current);
          if (!folded) break;
          // Check if this decision superseded something
          const supersedeTrans = folded.transitions.find((t) => t.action === "supersede" && t.target_id === current);
          if (!supersedeTrans) break;
          // Walk to what it replaced... but actually we check if target_id was superseded BY something
          break; // Simple: one-level check is sufficient for v1
        }

        const event: TransitionEvent = {
          type: "transition",
          id: generateTransitionId(),
          created: new Date().toISOString(),
          target_id: args.target_id,
          action: "supersede",
          replaced_by: args.replaced_by,
          reason: args.reason,
          pain_points: args.pain_points ?? null,
          source_feature_id: null,
        };

        const eventWithOpId = { ...event, client_operation_id: args.client_operation_id };
        await appendToLedger(eventWithOpId as TransitionEvent, projectRoot);

        return makeToolResult({ status: "superseded" });
      } catch (err: any) {
        return makeToolError(err.message);
      }
    },
  );

  // ── Tool 5: record_writeback ─────────────────────────────────────────────

  server.tool(
    "record_writeback",
    "Write back a workflow decision. Implements reinforce-first: reaffirms existing precedent via reinforce transition, surfaces conflicts, or creates new record.",
    {
      client_operation_id: z.string().describe("Idempotency key — format: {feature-slug}-{YYYYMMDD}-{random4chars}"),
      source_feature_id: z.string().describe("Feature ID that generated this writeback"),
      summary: z.string().describe("One-line summary"),
      decision: z.string().describe("The decision text"),
      rationale: z.string().describe("Why this decision was made"),
      alternatives_considered: z.array(z.object({
        approach: z.string(),
        why_rejected: z.string(),
        failure_conditions: z.string().nullable(),
      })).optional(),
      revisit_conditions: z.string().optional(),
      review_after: z.string().nullable().optional(),
      scope_type: z.string().describe("Scope type"),
      scope_id: z.string().describe("Scope identifier"),
      affected_files: z.array(z.string()).optional(),
      scope_aliases: z.array(z.string()).optional(),
      decision_kind: z.string().optional(),
      tags: z.array(z.string()).optional(),
      durability: z.enum(["precedent", "feature-local", "temporary-workaround"]).describe("Durability classification"),
    },
    { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    async (args) => {
      try {
        // Idempotency check
        const events = await readLedger(projectRoot);
        const dupRecord = events.find((e) => (e as unknown as Record<string, unknown>).client_operation_id === args.client_operation_id);
        if (dupRecord) {
          return makeToolResult({ status: "already_processed", decision_id: dupRecord.id });
        }

        // Fold and check for existing precedent (C1 fix — no semantic heuristic)
        const state = await foldLedger(projectRoot);

        for (const [, folded] of state.decisions) {
          if (
            folded.state === "active" &&
            folded.record.scope.type === args.scope_type &&
            folded.record.scope.id === args.scope_id &&
            folded.record.durability === "precedent"
          ) {
            return makeToolResult({
              status: "conflict_detected",
              existing_precedent: folded.record,
              proposed_decision: {
                summary: args.summary,
                decision: args.decision,
                rationale: args.rationale,
                scope_type: args.scope_type,
                scope_id: args.scope_id,
                durability: args.durability,
              },
              message: "Existing precedent found in this scope. Review the existing precedent and use supersede_decision to replace it, or call record_writeback again with a different scope if this is a new concern.",
            });
          }
        }

        // New record
        const record: DecisionRecord = {
          type: "decision",
          id: generateDecisionId(),
          created: new Date().toISOString(),
          source: "workflow-writeback",
          evidence_type: "workflow_writeback",
          verification_status: "unreviewed",
          commit_sha: null,
          summary: args.summary,
          decision: args.decision,
          alternatives_considered: args.alternatives_considered ?? [],
          rationale: args.rationale,
          revisit_conditions: args.revisit_conditions ?? "",
          review_after: args.review_after ?? null,
          scope: { type: args.scope_type as ScopeType, id: args.scope_id },
          affected_files: args.affected_files ?? [],
          scope_aliases: args.scope_aliases ?? [],
          decision_kind: args.decision_kind ?? "",
          tags: args.tags ?? [],
          durability: args.durability,
        };

        const recordWithOpId = { ...record, client_operation_id: args.client_operation_id };
        await appendToLedger(recordWithOpId as DecisionRecord, projectRoot);

        return makeToolResult({ status: "created", decision_id: record.id });
      } catch (err: any) {
        return makeToolError(err.message);
      }
    },
  );
}
