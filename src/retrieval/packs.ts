// context-ledger — retrieval/packs
// Decision pack builder with token budgeting and priority-based trimming.

import type { DecisionRecord, InboxItem, FoldedDecision } from "../ledger/index.js";
import type { DerivedScope } from "./scope.js";
import type { LedgerConfig } from "../config.js";

// ── Types ────────────────────────────────────────────────────────────────────

export type MatchReason = "scope_hit" | "file_path_hit" | "tag_match" | "broad_fallback";

export interface PackEntry {
  record: DecisionRecord;
  match_reason: MatchReason;
  retrieval_weight: number;
  review_overdue?: boolean;
}

export interface AbandonedEntry {
  record: DecisionRecord;
  match_reason: MatchReason;
  pain_points: string[];
}

export interface SupersededEntry {
  record: DecisionRecord;
  match_reason: MatchReason;
  replaced_by: string;
}

export interface DecisionPack {
  derived_scope: DerivedScope | null;
  active_precedents: PackEntry[];
  abandoned_approaches: AbandonedEntry[];
  recently_superseded: SupersededEntry[];
  pending_inbox_items: InboxItem[];
  no_precedent_scopes: string[];
  token_estimate: number;
  truncated: boolean;
}

// ── Pack Builder ─────────────────────────────────────────────────────────────

export function buildDecisionPack(
  decisions: Array<FoldedDecision & { match_reason: MatchReason }>,
  scope: DerivedScope | null,
  inboxItems: InboxItem[],
  params: { include_superseded?: boolean; include_unreviewed?: boolean; limit?: number; offset?: number },
  config: LedgerConfig,
): DecisionPack {
  const now = Date.now();
  const ninetyDaysMs = 90 * 24 * 60 * 60 * 1000;
  const limit = params.limit ?? config.retrieval.default_limit;
  const offset = params.offset ?? 0;

  // ── Classify into buckets ────────────────────────────────────────────────

  const activePrecedents: PackEntry[] = [];
  const abandonedApproaches: AbandonedEntry[] = [];
  const recentlySuperseded: SupersededEntry[] = [];

  for (const folded of decisions) {
    if (folded.state === "active") {
      const reviewOverdue =
        folded.record.durability === "temporary-workaround" &&
        folded.record.review_after !== null &&
        new Date(folded.record.review_after).getTime() < now;

      activePrecedents.push({
        record: folded.record,
        match_reason: folded.match_reason,
        retrieval_weight: folded.effective_rank_score,
        ...(reviewOverdue ? { review_overdue: true } : {}),
      });
    } else if (folded.state === "abandoned") {
      const lastAbandon = findLastTransition(folded, "abandon");
      abandonedApproaches.push({
        record: folded.record,
        match_reason: folded.match_reason,
        pain_points: lastAbandon?.pain_points ?? [],
      });
    } else if (folded.state === "superseded" && params.include_superseded) {
      const lastSupersede = findLastTransition(folded, "supersede");
      if (lastSupersede && now - new Date(lastSupersede.created).getTime() <= ninetyDaysMs) {
        recentlySuperseded.push({
          record: folded.record,
          match_reason: folded.match_reason,
          replaced_by: folded.replaced_by ?? "",
        });
      }
    }
  }

  // ── Sort ─────────────────────────────────────────────────────────────────

  activePrecedents.sort((a, b) => b.retrieval_weight - a.retrieval_weight);
  abandonedApproaches.sort((a, b) => b.record.created.localeCompare(a.record.created));
  recentlySuperseded.sort((a, b) => b.record.created.localeCompare(a.record.created));

  // ── Offset + limit on active_precedents ──────────────────────────────────

  const paginatedActive = activePrecedents.slice(offset, offset + limit);

  // ── Pending inbox ────────────────────────────────────────────────────────

  const pendingInbox = inboxItems.filter((item) => item.status === "pending");

  // ── No-precedent scopes ──────────────────────────────────────────────────

  const noPrecedentScopes: string[] = [];
  if (scope && paginatedActive.length === 0) {
    noPrecedentScopes.push(scope.id);
  }

  // ── Build pack ───────────────────────────────────────────────────────────

  const pack: DecisionPack = {
    derived_scope: scope,
    active_precedents: paginatedActive,
    abandoned_approaches: abandonedApproaches,
    recently_superseded: recentlySuperseded,
    pending_inbox_items: pendingInbox,
    no_precedent_scopes: noPrecedentScopes,
    token_estimate: 0,
    truncated: false,
  };

  // ── Token budgeting ──────────────────────────────────────────────────────

  const budget = config.retrieval.token_budget;
  pack.token_estimate = estimateTokens(pack);

  if (pack.token_estimate > budget) {
    pack.truncated = true;

    // 1. Drop recently_superseded (all at once)
    if (pack.recently_superseded.length > 0) {
      pack.recently_superseded = [];
      pack.token_estimate = estimateTokens(pack);
    }

    // 2. Drop abandoned_approaches (all at once)
    if (pack.token_estimate > budget && pack.abandoned_approaches.length > 0) {
      pack.abandoned_approaches = [];
      pack.token_estimate = estimateTokens(pack);
    }

    // 3. Drop active_precedents from tail (lowest score first), one at a time
    while (pack.token_estimate > budget && pack.active_precedents.length > 0) {
      pack.active_precedents.pop();
      pack.token_estimate = estimateTokens(pack);
    }

    console.error(
      `context-ledger: decision pack trimmed to ${budget} token budget (truncated: true)`,
    );
  }

  return pack;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function estimateTokens(pack: DecisionPack): number {
  return Math.ceil(JSON.stringify(pack).length / 4);
}

function findLastTransition(
  folded: FoldedDecision,
  action: string,
): import("../ledger/index.js").TransitionEvent | undefined {
  for (let i = folded.transitions.length - 1; i >= 0; i--) {
    if (folded.transitions[i].action === action) return folded.transitions[i];
  }
  return undefined;
}
