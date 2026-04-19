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

export type MistakeEntry =
  | {
      kind: "superseded_with_pain_points";
      record: DecisionRecord;
      match_reason: MatchReason;
      pain_points: string[];
      replaced_by: string;
    }
  | {
      kind: "abandoned";
      record: DecisionRecord;
      match_reason: MatchReason;
      reason: string;
      pain_points: string[];
    }
  | {
      kind: "rejected_inbox_item";
      inbox_id: string;
      commit_sha: string;
      commit_message: string;
      changed_files: string[];
      rejection_reason: string;
      rejected_at: string;
    };

export interface DecisionPack {
  derived_scope: DerivedScope | null;
  active_precedents: PackEntry[];
  abandoned_approaches: AbandonedEntry[];
  recently_superseded: SupersededEntry[];
  pending_inbox_items: InboxItem[];
  mistakes_in_scope: MistakeEntry[];
  no_precedent_scopes: string[];
  token_estimate: number;
  truncated: boolean;
}

// ── Pack Builder ─────────────────────────────────────────────────────────────

export function buildDecisionPack(
  decisions: Array<FoldedDecision & { match_reason: MatchReason }>,
  scope: DerivedScope | null,
  inboxItems: InboxItem[],
  rejectedInboxItems: InboxItem[],
  params: { include_superseded?: boolean; include_unreviewed?: boolean; include_feature_local?: boolean; limit?: number; offset?: number },
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

  // ── Mistakes in scope (antipatterns: abandoned, superseded w/ pain_points, rejected inbox) ──
  const mistakesInScope: MistakeEntry[] = [];

  for (const folded of decisions) {
    // Exclude commit_inferred from mistakes_in_scope only (not from abandoned_approaches /
    // recently_superseded, which remain informational). Rationale: mistakes_in_scope
    // actively shapes agent behavior (do-not-repeat) and the 0.2 weight means the record
    // is unreviewed. Surface commit_inferred records as context via the legacy buckets only.
    if (folded.record.evidence_type === "commit_inferred") continue;

    if (folded.state === "superseded") {
      const lastSupersede = findLastTransition(folded, "supersede");
      const pp = lastSupersede?.pain_points ?? [];
      if (pp.length > 0) {
        mistakesInScope.push({
          kind: "superseded_with_pain_points",
          record: folded.record,
          match_reason: folded.match_reason,
          pain_points: pp,
          replaced_by: folded.replaced_by ?? "",
        });
      }
    } else if (folded.state === "abandoned") {
      const lastAbandon = findLastTransition(folded, "abandon");
      mistakesInScope.push({
        kind: "abandoned",
        record: folded.record,
        match_reason: folded.match_reason,
        reason: lastAbandon?.reason ?? "",
        pain_points: lastAbandon?.pain_points ?? [],
      });
    }
  }

  for (const item of rejectedInboxItems) {
    mistakesInScope.push({
      kind: "rejected_inbox_item",
      inbox_id: item.inbox_id,
      commit_sha: item.commit_sha,
      commit_message: item.commit_message,
      changed_files: item.changed_files,
      rejection_reason: item.rejection_reason ?? "",
      rejected_at: item.last_prompted_at ?? item.created,
    });
  }

  // Sort order per spec: (1) superseded_with_pain_points, (2) abandoned, (3) rejected_inbox_item.
  // Within each kind, most recent first.
  const kindOrder: Record<MistakeEntry["kind"], number> = {
    superseded_with_pain_points: 0,
    abandoned: 1,
    rejected_inbox_item: 2,
  };
  mistakesInScope.sort((a, b) => {
    const ko = kindOrder[a.kind] - kindOrder[b.kind];
    if (ko !== 0) return ko;
    const aTime = a.kind === "rejected_inbox_item" ? a.rejected_at : a.record.created;
    const bTime = b.kind === "rejected_inbox_item" ? b.rejected_at : b.record.created;
    return bTime.localeCompare(aTime);
  });

  // ── Dedup (Bucket 1 fix 1.1): records promoted to mistakes_in_scope must not
  //    also appear in abandoned_approaches or recently_superseded — otherwise the
  //    token budget double-counts them.
  const promotedIds = new Set(
    mistakesInScope
      .filter((m): m is Extract<MistakeEntry, { record: DecisionRecord }> => "record" in m)
      .map((m) => m.record.id),
  );
  const dedupedAbandoned = abandonedApproaches.filter((e) => !promotedIds.has(e.record.id));
  const dedupedSuperseded = recentlySuperseded.filter((e) => !promotedIds.has(e.record.id));

  // ── Sort ─────────────────────────────────────────────────────────────────

  activePrecedents.sort((a, b) => b.retrieval_weight - a.retrieval_weight);
  dedupedAbandoned.sort((a, b) => b.record.created.localeCompare(a.record.created));
  dedupedSuperseded.sort((a, b) => b.record.created.localeCompare(a.record.created));

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
    abandoned_approaches: dedupedAbandoned,
    recently_superseded: dedupedSuperseded,
    pending_inbox_items: pendingInbox,
    mistakes_in_scope: mistakesInScope,
    no_precedent_scopes: noPrecedentScopes,
    token_estimate: 0,
    truncated: false,
  };

  // ── Token budgeting ────────────────────────────────────────────────────────
  //
  // Trim priority (first to drop → last to drop), locked by user triage (spec-literal):
  //   1. active_precedents  (from tail — lowest effective_rank_score first)
  //   2. recently_superseded  (drop entirely)
  //   3. abandoned_approaches  (drop entirely)
  //   4. pending_inbox_items  (cap via inbox_max_items_per_session, then pop from tail)
  //   5. mistakes_in_scope  ← LAST casualty; antipatterns are the highest-signal-per-token
  //      data for preventing repeats. Dropped only if every peer bucket is empty.
  //
  // Within mistakes_in_scope: pop from tail (least-recent per sort order).
  // `truncated: true` is set once on entering this block; never reset to false.

  const budget = config.retrieval.token_budget;
  pack.token_estimate = estimateTokens(pack);

  if (pack.token_estimate > budget) {
    pack.truncated = true;

    // 1. active_precedents — pop from tail (already sorted descending by retrieval_weight).
    while (pack.token_estimate > budget && pack.active_precedents.length > 0) {
      pack.active_precedents.pop();
      pack.token_estimate = estimateTokens(pack);
    }

    // 2. recently_superseded — drop entirely.
    if (pack.token_estimate > budget && pack.recently_superseded.length > 0) {
      pack.recently_superseded = [];
      pack.token_estimate = estimateTokens(pack);
    }

    // 3. abandoned_approaches — drop entirely.
    if (pack.token_estimate > budget && pack.abandoned_approaches.length > 0) {
      pack.abandoned_approaches = [];
      pack.token_estimate = estimateTokens(pack);
    }

    // 4. pending_inbox_items — cap first, then pop from tail.
    if (pack.token_estimate > budget && pack.pending_inbox_items.length > 0) {
      const cap = config.capture.inbox_max_items_per_session;
      if (pack.pending_inbox_items.length > cap) {
        pack.pending_inbox_items = pack.pending_inbox_items.slice(0, cap);
        pack.token_estimate = estimateTokens(pack);
      }
      while (pack.token_estimate > budget && pack.pending_inbox_items.length > 0) {
        pack.pending_inbox_items.pop();
        pack.token_estimate = estimateTokens(pack);
      }
    }

    // 5. mistakes_in_scope — last resort. Pop from tail.
    while (pack.token_estimate > budget && pack.mistakes_in_scope.length > 0) {
      pack.mistakes_in_scope.pop();
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
