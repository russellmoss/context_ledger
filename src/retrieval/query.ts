// context-ledger — retrieval/query
// Query orchestrator: ties scope derivation, fold, and pack building together.

import type { DecisionRecord, LifecycleState, FoldedDecision, InboxItem, MaterializedState } from "../ledger/index.js";
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
  include_cross_scope_supersede?: boolean;
  include_unreviewed?: boolean;
  include_feature_local?: boolean;
  limit?: number;
  offset?: number;
}

export interface SearchResult {
  record: DecisionRecord;
  state: LifecycleState;
  effective_rank_score: number;
}

// ── Scope intersection for rejected inbox items ──────────────────────────────
//
// Mirrors deriveScope() in src/retrieval/scope.ts:31–102. Any future change to
// deriveScope MUST update this helper in lockstep to prevent drift.
//
// Derivation order (must match scope.ts):
//   1. config scope_mappings (longest-prefix match)
//   2. scope_aliases on active decisions
//   3. directory fallback (segment after `src/`)
// Final fallback (Bucket 1 fix 1.5): if changed_files is empty, substring-match
// scope.id against commit_message.
function inboxItemIntersectsScope(
  item: InboxItem,
  scope: DerivedScope | null,
  state: MaterializedState,
  config: LedgerConfig,
): boolean {
  if (scope === null) return false; // recency fallback handled separately

  const mappings = config.capture.scope_mappings;

  // Fallback: empty changed_files → commit_message substring match against scope.id.
  if (item.changed_files.length === 0) {
    return item.commit_message.toLowerCase().includes(scope.id.toLowerCase());
  }

  for (const file of item.changed_files) {
    const n = normalizePath(file);

    // 1. scope_mappings (longest-prefix match — mirror scope.ts:46–62)
    for (const [prefix, target] of Object.entries(mappings)) {
      if (
        n.startsWith(normalizePath(prefix)) &&
        (target as { type?: string; id?: string }).type === scope.type &&
        (target as { type?: string; id?: string }).id === scope.id
      ) {
        return true;
      }
    }

    // 2. scope_aliases — scan active decisions (mirror scope.ts:65–73)
    for (const folded of state.decisions.values()) {
      if (folded.state !== "active") continue;
      if (folded.record.scope.type !== scope.type || folded.record.scope.id !== scope.id) continue;
      for (const alias of folded.record.scope_aliases) {
        if (n.startsWith(normalizePath(alias))) return true;
      }
    }

    // 2.5 Monorepo-root fallback (v1.2.2) — mirror scope.ts monorepo_root branch.
    // If the file lives under packages/<pkg>/..., derive "packages/<pkg>" and
    // compare against the queried scope.
    const monorepoRoots = ["packages", "apps", "services"];
    const msegments = n.split("/").filter((s) => s !== "" && s !== "." && s !== "..");
    if (msegments.length >= 2 && monorepoRoots.includes(msegments[0])) {
      const pkg = msegments[1];
      if (pkg && !pkg.startsWith(".") && `${msegments[0]}/${pkg}` === scope.id) {
        return true;
      }
    }

    // 3. Directory fallback (mirror scope.ts:76–89)
    const segments = n.split("/");
    const srcIdx = segments.indexOf("src");
    const segment =
      srcIdx >= 0 && srcIdx + 1 < segments.length ? segments[srcIdx + 1] : segments[0];
    if (segment === scope.id) return true;
  }
  return false;
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

  // v1.2.2 council C3: resolve include_superseded once with config fallback,
  // reuse in filter loop + pack builder to avoid split-brain.
  const includeSuperseded = params.include_superseded ?? config.retrieval.include_superseded;
  // v1.2.2 Q2 human-gate: cross-scope supersedes default surface-on. Opt out
  // per query via include_cross_scope_supersede: false. No config-level field.
  const includeCrossScopeSupersede = params.include_cross_scope_supersede ?? true;

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

    // Feature-local exclusion: exclude unless exact file_path match on affected_files,
    // OR the caller opts in via include_feature_local (global short-circuit).
    if (folded.record.durability === "feature-local" && !params.include_feature_local) {
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

      // Cross-scope supersede traversal (v1.2.2) — one hop only.
      // derivedScope is guaranteed non-null here (we are inside the outer
      // `else { derivedScope !== null }` branch — do NOT hoist this check
      // out). A superseded record surfaces in scope S's pack when its
      // replaced_by points to a decision whose scope matches S, even if the
      // superseded record's own scope was narrower or different.
      //
      // Surfaces at default params: cross-scope supersedes are the genealogy
      // of the record IN scope, not stale history. Opt-out per query via
      // include_cross_scope_supersede: false. Unlike same-scope superseded
      // records, this branch does NOT honor include_superseded — those are
      // different semantics (see Phase 2 note in the guide).
      //
      // Replacement may be missing if the ledger was trimmed/corrupted —
      // `state.decisions.get` returns undefined; the guard below treats it
      // as "no match" and the record is skipped.
      if (
        !matchReason &&
        folded.state === "superseded" &&
        folded.replaced_by &&
        includeCrossScopeSupersede
      ) {
        const replacement = state.decisions.get(folded.replaced_by);
        if (
          replacement &&
          replacement.record.scope.type === derivedScope.type &&
          replacement.record.scope.id === derivedScope.id
        ) {
          matchReason = "cross_scope_supersede";
        }
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

  // 6. Read dismissed inbox items with rejection_reason for mistakes_in_scope.
  // Scope-intersection required when derivedScope is non-null.
  // Recency fallback (derivedScope === null): include N=10 most recent dismissed
  // inbox items with rejection_reason, sorted by rejected_at desc (user triage Q4).
  // Durability is a DecisionRecord field — inbox items do not carry durability,
  // so include_feature_local does not filter this list.
  const RECENCY_FALLBACK_REJECTED_INBOX_CAP = 10;

  const rejectedInboxItems: InboxItem[] = derivedScope
    ? allInbox.filter(
        (item) =>
          item.status === "dismissed" &&
          typeof item.rejection_reason === "string" &&
          item.rejection_reason.length > 0 &&
          inboxItemIntersectsScope(item, derivedScope, state, config),
      )
    : allInbox
        .filter(
          (item) =>
            item.status === "dismissed" &&
            typeof item.rejection_reason === "string" &&
            item.rejection_reason.length > 0,
        )
        .sort((a, b) => {
          const aTime = a.last_prompted_at ?? a.created;
          const bTime = b.last_prompted_at ?? b.created;
          return bTime.localeCompare(aTime);
        })
        .slice(0, RECENCY_FALLBACK_REJECTED_INBOX_CAP);

  // 7. Build and return decision pack
  return buildDecisionPack(filtered, derivedScope, pendingInbox, rejectedInboxItems, params, config, includeSuperseded, includeCrossScopeSupersede);
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
