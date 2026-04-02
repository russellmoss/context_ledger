// context-ledger — retrieval/query
// Query orchestrator: ties scope derivation, fold, and pack building together.

import type { DecisionRecord, LifecycleState, FoldedDecision, InboxItem } from "../ledger/index.js";
import { foldLedger, readInbox } from "../ledger/index.js";
import type { LedgerConfig } from "../config.js";
import { loadConfig } from "../config.js";
import type { DerivedScope } from "./scope.js";
import { deriveScope, deriveScopeFromHints, normalizePath } from "./scope.js";
import type { DecisionPack, MatchReason } from "./packs.js";
import { buildDecisionPack } from "./packs.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface QueryDecisionsParams {
  file_path?: string;
  query?: string;
  scope_type?: string;
  scope_id?: string;
  decision_kind?: string;
  tags?: string[];
  include_superseded?: boolean;
  include_unreviewed?: boolean;
  limit?: number;
  offset?: number;
}

export interface SearchResult {
  record: DecisionRecord;
  state: LifecycleState;
  effective_rank_score: number;
}

// ── Query Decisions ──────────────────────────────────────────────────────────

export async function queryDecisions(
  params: QueryDecisionsParams,
  projectRoot: string,
): Promise<DecisionPack> {
  // 1. Load config and fold in parallel
  const [config, state] = await Promise.all([
    loadConfig(projectRoot),
    foldLedger(projectRoot),
  ]);

  // 2. Derive scope
  const derivedScope = deriveScope(
    { file_path: params.file_path, query: params.query, scope_type: params.scope_type, scope_id: params.scope_id },
    config,
    state.decisions,
  );

  // 3. Collect all hint scope IDs for broader filtering
  const hintScopeIds = params.query
    ? deriveScopeFromHints(params.query, config.retrieval.feature_hint_mappings)
    : [];

  // 4. Filter decisions
  const normalizedFilePath = params.file_path ? normalizePath(params.file_path) : null;
  const filtered: Array<FoldedDecision & { match_reason: MatchReason }> = [];

  for (const folded of state.decisions.values()) {
    // Unreviewed exclusion (default: exclude)
    if (
      !(params.include_unreviewed ?? config.retrieval.include_unreviewed) &&
      folded.record.verification_status === "unreviewed"
    ) {
      continue;
    }

    // Feature-local exclusion: exclude unless exact file_path match on affected_files
    if (folded.record.durability === "feature-local") {
      if (!normalizedFilePath) continue;
      const hasMatch = folded.record.affected_files.some(
        (f) => normalizePath(f) === normalizedFilePath,
      );
      if (!hasMatch) continue;
    }

    // decision_kind filter (soft, case-insensitive substring)
    if (params.decision_kind) {
      if (!folded.record.decision_kind.toLowerCase().includes(params.decision_kind.toLowerCase())) {
        continue;
      }
    }

    // Determine match reason
    let matchReason: MatchReason | null = null;

    if (derivedScope === null) {
      // Recency fallback: include all active precedent-durability decisions
      if (folded.state === "active" && folded.record.durability === "precedent") {
        matchReason = "broad_fallback";
      } else if (folded.state === "abandoned" || folded.state === "superseded") {
        matchReason = "broad_fallback";
      }
    } else {
      // Scope hit
      if (
        folded.record.scope.type === derivedScope.type &&
        folded.record.scope.id === derivedScope.id
      ) {
        matchReason = "scope_hit";
      }

      // Check hint scopes too
      if (!matchReason && hintScopeIds.includes(folded.record.scope.id)) {
        matchReason = "scope_hit";
      }

      // File path hit
      if (!matchReason && normalizedFilePath) {
        const hasFileMatch = folded.record.affected_files.some(
          (f) => normalizePath(f) === normalizedFilePath,
        );
        if (hasFileMatch) matchReason = "file_path_hit";
      }

      // Tag match
      if (!matchReason && params.tags && params.tags.length > 0) {
        const hasTagOverlap = folded.record.tags.some((t) =>
          params.tags!.some((pt) => t.toLowerCase() === pt.toLowerCase()),
        );
        if (hasTagOverlap) matchReason = "tag_match";
      }
    }

    if (!matchReason) continue;

    filtered.push({ ...folded, match_reason: matchReason });
  }

  // Sort recency fallback by created desc
  if (derivedScope === null) {
    filtered.sort((a, b) => b.record.created.localeCompare(a.record.created));
  }

  // 5. Read and filter inbox items
  const allInbox = await readInbox(projectRoot);
  const pendingInbox = allInbox
    .filter((item) => item.status === "pending")
    .sort((a, b) => {
      // Tier 2 (question_needed) before Tier 1 (draft_needed)
      if (a.type !== b.type) {
        return a.type === "question_needed" ? -1 : 1;
      }
      // Recency tiebreaker (most recent first)
      return b.created.localeCompare(a.created);
    })
    .slice(0, config.capture.inbox_max_items_per_session);

  // 6. Build and return decision pack
  return buildDecisionPack(filtered, derivedScope, pendingInbox, params, config);
}

// ── Search Decisions ─────────────────────────────────────────────────────────

export async function searchDecisions(
  query: string,
  projectRoot: string,
  limit?: number,
): Promise<SearchResult[]> {
  const state = await foldLedger(projectRoot);
  const tokens = query.toLowerCase().split(/\s+/).filter((t) => t.length > 0);
  const effectiveLimit = limit ?? 20;

  const results: SearchResult[] = [];

  for (const folded of state.decisions.values()) {
    if (folded.state !== "active") continue;

    const searchText = [
      folded.record.summary,
      folded.record.decision,
      folded.record.rationale,
      folded.record.tags.join(" "),
      folded.record.decision_kind,
    ]
      .join(" ")
      .toLowerCase();

    const allMatch = tokens.every((t) => searchText.includes(t));
    if (!allMatch) continue;

    results.push({
      record: folded.record,
      state: folded.state,
      effective_rank_score: folded.effective_rank_score,
    });
  }

  results.sort((a, b) => b.effective_rank_score - a.effective_rank_score);
  return results.slice(0, effectiveLimit);
}
