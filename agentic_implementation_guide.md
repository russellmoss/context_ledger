# Agentic Implementation Guide — `mistakes_in_scope` in Decision Pack

**Feature:** Surface antipatterns first in the decision pack returned by `query_decisions`.
**Spec:** context-ledger-design-v2.md (Retrieval section — to be extended in Phase 8)
**Exploration:** exploration-results.md, code-inspector-findings.md, pattern-finder-findings.md
**North star:** Autonomy axis #1 (retrieval quality). Strictly additive. No fold/event/hook changes.

---

## How To Execute This Guide

- Execute phases in order. Do not skip.
- At each **STOP AND REPORT** checkpoint: print what changed, print validation output, wait for the user's go-ahead before continuing.
- Every validation gate is concrete bash. If a gate fails, fix before proceeding.
- Import merges, not additions. Never add a second `import` from the same module.
- All imports use `.js` extensions (Node16 resolution). No exceptions.
- Append-only JSONL. This feature does not write JSONL at all; any attempt to do so is a bug.
- Post-commit hook is untouched. Verify after every phase: `git diff --stat src/capture/ | wc -l` must be `0`.
- Make one commit per phase, with a message prefix `feat(retrieval-mistakes):`. Pre-commit hook runs in blocking mode — update docs before committing or the commit is rejected.

---

## Phase 0 — Context Load (read-only, 5 min)

Read these files fully before touching code:
- `context-ledger-design-v2.md` — Retrieval section + Decision Pack Response schema
- `CLAUDE.md` — invariants
- `src/retrieval/packs.ts` — single DecisionPack construction site at lines 117–126
- `src/retrieval/query.ts` — orchestrator
- `src/retrieval/scope.ts` — `deriveScope`, `normalizePath`, `deriveScopeFromHints`
- `src/mcp/read-tools.ts` — `query_decisions` registration
- `src/mcp/write-tools.ts:245–275` — `reject_pending` handler (dynamic `rejection_reason` write)
- `src/ledger/events.ts` — `InboxItem` interface at lines 88–103
- `src/retrieval/smoke-test.ts` — test harness pattern

**Design decisions locked by user (council pass 1 triage):**
1. **Trim order → Option A (spec-literal).** Over-budget packs trim `active_precedents` from the tail FIRST, then `recently_superseded`, then `abandoned_approaches`, then cap `pending_inbox_items`, and `mistakes_in_scope` is the last casualty. Antipatterns are the irrecoverable signal under token pressure.
2. **`include_feature_local` → Option A (global short-circuit).** Flag bypasses the existing feature-local filter entirely for all sections.
3. **CLI → Replace.** Swap `searchDecisions` for `queryDecisions` in the CLI `query` handler. Render the full decision pack. The CLI becomes a faithful debugging mirror of what the agent sees over MCP.
4. **`rejection_reason` on `InboxItem` → Ratify.** Promote to a typed optional field. Remove the `as unknown as Record<string, unknown>` cast. This is NOT an event-schema change (InboxItem is a workflow queue entry, not a `DecisionRecord` / `TransitionEvent`) — but Phase 8 MUST document it as an explicit, separate spec decision.
5. **Recency fallback → Include capped at N=10.** When `derivedScope === null`, include the N=10 most recent dismissed inbox items with `rejection_reason`, sorted by `rejected_at` desc. Honors the "every scope-derivation path" instruction.

---

## Phase 1 — Type Definitions (intentionally breaks the build)

**Goal:** add types for `MistakeEntry`, `mistakes_in_scope`, typed `rejection_reason`, and `include_feature_local`. Build will fail at the pack construction site — that's the checklist.

### 1.1 Extend `InboxItem` with typed `rejection_reason`

**File:** `src/ledger/events.ts`

Locate the `InboxItem` interface (lines 88–103). Add one field right before the closing brace:

```ts
  rejection_reason?: string;
```

Final `InboxItem`:
```ts
export interface InboxItem {
  inbox_id: string;
  type: InboxType;
  created: string;
  commit_sha: string;
  commit_message: string;
  change_category: string;
  changed_files: string[];
  diff_summary: string;
  priority: "normal";
  expires_after: string;
  times_shown: number;
  last_prompted_at: string | null;
  status: InboxStatus;
  proposed_decision?: ProposedDecisionDraft;
  rejection_reason?: string;
}
```

### 1.2 Add `MistakeEntry` discriminated union to `src/retrieval/packs.ts`

Insert immediately after the `SupersededEntry` interface (after line 29, before `DecisionPack`):

```ts
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
```

### 1.3 Add `mistakes_in_scope` to `DecisionPack` (packs.ts:31–40)

```ts
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
```

### 1.4 Initialize `mistakes_in_scope: []` at the single construction site (packs.ts:117–126)

```ts
  const pack: DecisionPack = {
    derived_scope: scope,
    active_precedents: paginatedActive,
    abandoned_approaches: abandonedApproaches,
    recently_superseded: recentlySuperseded,
    pending_inbox_items: pendingInbox,
    mistakes_in_scope: [],
    no_precedent_scopes: noPrecedentScopes,
    token_estimate: 0,
    truncated: false,
  };
```

(Population logic lands in Phase 2. This keeps build green after Phase 1.)

### 1.5 Add `include_feature_local` to `QueryDecisionsParams` (query.ts:15–26)

```ts
export interface QueryDecisionsParams {
  file_path?: string;
  query?: string;
  scope_type?: string;
  scope_id?: string;
  decision_kind?: string;
  tags?: string[];
  include_superseded?: boolean;
  include_unreviewed?: boolean;
  include_feature_local?: boolean;
  limit?: number;
  offset?: number;
}
```

### 1.6 Re-export `MistakeEntry` from retrieval barrel

**File:** `src/retrieval/index.ts` line 7. Add `MistakeEntry` to the existing type re-export:

```ts
export type { MatchReason, PackEntry, AbandonedEntry, SupersededEntry, MistakeEntry, DecisionPack } from "./packs.js";
```

### 1.7 Add `include_feature_local` to the MCP Zod schema

**File:** `src/mcp/read-tools.ts` inside the `query_decisions` schema object (lines 12–23). Add a new entry after `include_unreviewed`:

```ts
      include_feature_local: z.boolean().optional().describe("Include feature-local durability records (overrides the default file-path-match requirement). Default false."),
```

### Phase 1 Validation Gate

Run:

```bash
npm run build 2>&1 | tee /tmp/ctx-build-p1.log
grep -c "error TS" /tmp/ctx-build-p1.log || echo "0 errors"
grep "error TS" /tmp/ctx-build-p1.log | awk '{print $1}' | sort -u
```

**Expected:** zero TS errors. (Phase 1 was designed to avoid type errors because `mistakes_in_scope: []` and the new optional field `rejection_reason?` are both safe additions.)

Also verify:

```bash
grep -n "mistakes_in_scope" src/retrieval/packs.ts
grep -n "rejection_reason" src/ledger/events.ts
grep -n "include_feature_local" src/retrieval/query.ts src/mcp/read-tools.ts
grep -n "MistakeEntry" src/retrieval/index.ts
git diff --stat src/capture/ | wc -l
```

**Expected:**
- `mistakes_in_scope` present in `DecisionPack` and construction site.
- `rejection_reason?: string` present in `InboxItem` (only if Q2 = ratify — see Q-gate below).
- `include_feature_local` present in both files.
- `MistakeEntry` re-exported.
- `src/capture/` untouched — wc line count `0`.

Additional construction-site safety check (Bucket 1 fix 1.4):

```bash
# Must be 0 — no other DecisionPack construction sites exist
grep -rn ": DecisionPack" src/ | grep -v "src/retrieval/packs.ts" | wc -l
```

**Note on MCP response contract (Bucket 1 fix 1.9):** MCP `query_decisions` returns `JSON.stringify(pack, null, 2)` without a Zod response schema. The response-shape change is implicit via the `DecisionPack` TypeScript interface. No MCP server code changes besides the input Zod schema and tool description.

**STOP AND REPORT** — show the build output, grep results, and the 0-count for the extra construction-site grep. Wait for go-ahead. Commit: `feat(retrieval-mistakes): phase 1 — type definitions`.

---

## Phase 2 — Pack Builder Logic

**Goal:** populate `mistakes_in_scope` in `buildDecisionPack`. Accept rejected inbox items as a new parameter. Respect `commit_inferred` exclusion explicitly.

### 2.1 Extend `buildDecisionPack` signature

**File:** `src/retrieval/packs.ts` — update the function signature at lines 44–50 to accept rejected inbox items and the feature-local flag:

```ts
export function buildDecisionPack(
  decisions: Array<FoldedDecision & { match_reason: MatchReason }>,
  scope: DerivedScope | null,
  inboxItems: InboxItem[],
  rejectedInboxItems: InboxItem[],
  params: { include_superseded?: boolean; include_unreviewed?: boolean; include_feature_local?: boolean; limit?: number; offset?: number },
  config: LedgerConfig,
): DecisionPack {
```

### 2.2 Populate `mistakes_in_scope` inside the classification loop

Add this block immediately after the existing classification `for` loop (after packs.ts:92, before the sort section).

```ts
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
```

Use `dedupedAbandoned` and `dedupedSuperseded` in the pack construction site in 2.3 below (replace `abandonedApproaches` and `recentlySuperseded`).

### 2.3 Wire `mistakes_in_scope` into the pack construction site

Replace the stub from Phase 1:

```ts
    mistakes_in_scope: mistakesInScope,
```

### Phase 2 Validation Gate

```bash
npm run build 2>&1 | tee /tmp/ctx-build-p2.log
grep -c "error TS" /tmp/ctx-build-p2.log || echo "0 errors"
grep -n "findLastTransition\|commit_inferred\|rejectedInboxItems\|mistakesInScope" src/retrieval/packs.ts
git diff --stat src/capture/ | wc -l
```

**Expected:**
- Zero TS errors locally for packs.ts.
- One TS error **expected** at `src/retrieval/query.ts` where `buildDecisionPack(...)` is called — this is now called with the old arity. Phase 3 fixes the call site.
- `src/capture/` untouched.

**STOP AND REPORT** — report that the expected single call-site error at query.ts:153 is the handoff to Phase 3. Commit: `feat(retrieval-mistakes): phase 2 — pack builder populates mistakes_in_scope`.

---

## Phase 3 — Query Orchestration

**Goal:** plumb rejected inbox items and `include_feature_local` through `queryDecisions`.

### 3.1 Gate the feature-local filter on `include_feature_local`

**File:** `src/retrieval/query.ts` — update the filter block (lines 72–78) to respect the flag:

```ts
    // Feature-local exclusion: exclude unless exact file_path match on affected_files,
    // OR the caller opts in via include_feature_local.
    if (folded.record.durability === "feature-local" && !params.include_feature_local) {
      if (!normalizedFilePath) continue;
      const hasMatch = folded.record.affected_files.some(
        (f) => normalizePath(f) === normalizedFilePath,
      );
      if (!hasMatch) continue;
    }
```

### 3.2 Load rejected inbox items and scope-intersect

Add a helper at the top of the file (or co-locate in `src/retrieval/scope.ts` — see 3.4). For brevity, inline in `query.ts` above `queryDecisions`:

```ts
// Intersects an inbox item's changed_files with the derived scope.
// Mirrors deriveScope() in src/retrieval/scope.ts:31–102 — any future change to
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
  if (scope === null) return false; // see Q4 for recency fallback behavior

  const mappings = config.capture.scope_mappings;

  // Fallback: empty changed_files → commit_message substring match against scope.id.
  if (item.changed_files.length === 0) {
    return item.commit_message.toLowerCase().includes(scope.id.toLowerCase());
  }

  for (const file of item.changed_files) {
    const n = normalizePath(file);

    // 1. scope_mappings (longest-prefix match — mirror scope.ts:46–62)
    for (const [prefix, target] of Object.entries(mappings)) {
      if (n.startsWith(normalizePath(prefix)) && target.type === scope.type && target.id === scope.id) {
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

    // 3. Directory fallback (mirror scope.ts:76–89)
    const segments = n.split("/");
    const srcIdx = segments.indexOf("src");
    const segment = srcIdx >= 0 && srcIdx + 1 < segments.length ? segments[srcIdx + 1] : segments[0];
    if (segment === scope.id) return true;
  }
  return false;
}
```

Update the call sites in 3.3 to pass `state` (the `MaterializedState` from `foldLedger`) into `inboxItemIntersectsScope`.

**On durability filtering for rejected inbox items (Bucket 1 fix 1.6):** rejected inbox items are NOT filtered by durability because durability is a `DecisionRecord` field, not an `InboxItem` field. `include_feature_local` only affects the decision filter in query.ts:72–78.

### 3.3 Extend `queryDecisions` to read and filter dismissed inbox items

Inside `queryDecisions`, after the existing `pendingInbox` block (around query.ts:140–150), add:

```ts
  // Read dismissed inbox items with rejection_reason for mistakes_in_scope.
  // Scope-intersection is required; when scope is null (recency fallback), omit entirely.
  // User triage Q4: recency fallback (derivedScope === null) includes the N=10
  // most recent dismissed inbox items with rejection_reason, sorted by rejected_at desc.
  // This honors the "apply to every scope-derivation path" instruction.
  const RECENCY_FALLBACK_REJECTED_INBOX_CAP = 10;

  const rejectedInboxItems = derivedScope
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
```

### 3.4 Update the `buildDecisionPack` call site (query.ts:153)

```ts
  return buildDecisionPack(filtered, derivedScope, pendingInbox, rejectedInboxItems, params, config);
```

### Phase 3 Validation Gate

```bash
npm run build 2>&1 | tee /tmp/ctx-build-p3.log
grep -c "error TS" /tmp/ctx-build-p3.log || echo "0 errors"
grep -n "rejectedInboxItems\|inboxItemIntersectsScope\|include_feature_local" src/retrieval/query.ts
git diff --stat src/capture/ | wc -l
git diff --stat src/ledger/storage.ts | wc -l
```

**Expected:**
- Zero TS errors across the whole project.
- `rejectedInboxItems` threading visible.
- `src/capture/` untouched. `src/ledger/storage.ts` untouched (no new writes).

**STOP AND REPORT** — show grep output proving the filter flag and rejected-inbox flow are wired. Commit: `feat(retrieval-mistakes): phase 3 — query orchestration + include_feature_local`.

---

## Phase 4 — Trim-Order Rewrite (Option A — spec-literal, user-locked)

**Goal:** rewrite the trim block so `mistakes_in_scope` is the last casualty under token pressure. User explicitly locked Option A in triage.

### 4.1 Option A trim sequence

Replace the current trim block in `src/retrieval/packs.ts:130–157` with:

```ts
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
```

### 4.2 Behavior check

Under heavy token pressure on a hot scope, an over-budget pack can return zero `active_precedents` but a full `mistakes_in_scope` — this is the intentional "antipatterns > active precedents under token pressure" bet. If `mistakes_in_scope` is itself large enough to exceed the budget, it is trimmed from the tail (least recent first, per the Phase 2 sort order).

### Phase 4 Validation Gate

```bash
npm run build 2>&1 | tee /tmp/ctx-build-p4.log
grep -c "error TS" /tmp/ctx-build-p4.log || echo "0 errors"
grep -nA2 "Trim priority" src/retrieval/packs.ts
git diff --stat src/capture/ | wc -l
```

**Expected:** zero errors, new trim block visible with comment, hook untouched.

**STOP AND REPORT** — print the trim block and confirm which option was applied. Commit: `feat(retrieval-mistakes): phase 4 — trim order protects mistakes_in_scope`.

---

## Phase 5 — CLI Rendering (Q3 Replace — user-locked)

**Goal:** swap `searchDecisions` for `queryDecisions` in the CLI `query` handler and render the full decision pack. The CLI becomes a faithful debugging mirror of what the agent sees over MCP.

### 5.1 Replace `handleQuery` in `src/cli.ts`

Locate `handleQuery` at lines 133–162. Merge the retrieval import so the file imports `queryDecisions` and drops `searchDecisions` (unless another caller still needs it — grep first):

```bash
grep -n "searchDecisions" src/cli.ts
grep -rn "searchDecisions" src/ | grep -v "src/retrieval/"
```

If `searchDecisions` has no other consumers, remove it from the retrieval barrel and the import. Otherwise, just drop the CLI import.

Updated import (merge into existing line):

```ts
import { queryDecisions } from "./retrieval/index.js";
```

Replace the entire `handleQuery` body with a full-pack renderer:

```ts
async function handleQuery(queryText: string, projectRoot: string): Promise<void> {
  const pack = await queryDecisions({ query: queryText }, projectRoot);

  // Section 1 — Prior mistakes in this scope (rendered FIRST per spec).
  if (pack.mistakes_in_scope.length > 0) {
    console.log(`\nPrior mistakes in this scope (${pack.mistakes_in_scope.length}):\n`);
    for (const m of pack.mistakes_in_scope) {
      switch (m.kind) {
        case "superseded_with_pain_points":
          console.log(`  [superseded] ${m.record.id}  → replaced_by ${m.replaced_by}`);
          console.log(`    ${m.record.summary}`);
          for (const pp of m.pain_points) console.log(`    pain: ${pp}`);
          break;
        case "abandoned":
          console.log(`  [abandoned]  ${m.record.id}`);
          console.log(`    ${m.record.summary}`);
          if (m.reason) console.log(`    reason: ${m.reason}`);
          for (const pp of m.pain_points) console.log(`    pain: ${pp}`);
          break;
        case "rejected_inbox_item":
          console.log(`  [rejected]   ${m.inbox_id}  ${m.commit_sha.slice(0, 7)}`);
          console.log(`    ${m.commit_message}`);
          console.log(`    rejection: ${m.rejection_reason}`);
          break;
        default: {
          const _exhaustive: never = m;
          throw new Error(`Unhandled MistakeEntry kind: ${JSON.stringify(_exhaustive)}`);
        }
      }
    }
  }

  // Section 2 — Active precedents.
  if (pack.active_precedents.length > 0) {
    console.log(`\nActive precedents (${pack.active_precedents.length}):\n`);
    for (const p of pack.active_precedents) {
      const flags: string[] = [p.match_reason];
      if (p.review_overdue) flags.push("review_overdue");
      console.log(`  [active]     ${p.record.id}  weight=${p.retrieval_weight.toFixed(2)}  ${flags.join(" ")}`);
      console.log(`    ${p.record.summary}`);
      console.log(`    scope: ${p.record.scope.type}/${p.record.scope.id}  kind: ${p.record.decision_kind}  durability: ${p.record.durability}`);
    }
  }

  // Section 3 — Abandoned approaches (legacy bucket; may overlap with mistakes).
  if (pack.abandoned_approaches.length > 0) {
    console.log(`\nAbandoned approaches (${pack.abandoned_approaches.length}):\n`);
    for (const a of pack.abandoned_approaches) {
      console.log(`  [abandoned]  ${a.record.id}  ${a.match_reason}`);
      console.log(`    ${a.record.summary}`);
      for (const pp of a.pain_points) console.log(`    pain: ${pp}`);
    }
  }

  // Section 4 — Recently superseded (only populated with include_superseded=true).
  if (pack.recently_superseded.length > 0) {
    console.log(`\nRecently superseded (${pack.recently_superseded.length}):\n`);
    for (const s of pack.recently_superseded) {
      console.log(`  [superseded] ${s.record.id}  → ${s.replaced_by}`);
      console.log(`    ${s.record.summary}`);
    }
  }

  // Section 5 — Pending inbox items.
  if (pack.pending_inbox_items.length > 0) {
    console.log(`\nPending inbox items (${pack.pending_inbox_items.length}):\n`);
    for (const i of pack.pending_inbox_items) {
      console.log(`  [${i.type}] ${i.inbox_id}  ${i.commit_sha.slice(0, 7)}  ${i.change_category}`);
      console.log(`    ${i.commit_message}`);
    }
  }

  // Footer.
  const derived = pack.derived_scope
    ? `${pack.derived_scope.type}/${pack.derived_scope.id} (source: ${pack.derived_scope.source})`
    : "null (recency fallback)";
  console.log(`\n— derived_scope: ${derived}`);
  console.log(`— token_estimate: ${pack.token_estimate}${pack.truncated ? "  (truncated)" : ""}`);
  if (pack.no_precedent_scopes.length > 0) {
    console.log(`— no_precedent_scopes: ${pack.no_precedent_scopes.join(", ")}`);
  }

  const empty =
    pack.mistakes_in_scope.length === 0 &&
    pack.active_precedents.length === 0 &&
    pack.abandoned_approaches.length === 0 &&
    pack.recently_superseded.length === 0 &&
    pack.pending_inbox_items.length === 0;
  if (empty) console.log("\nNo matching decisions found.");
}
```

### 5.2 Cleanup: remove `searchDecisions` if unused

If the earlier grep showed zero other consumers of `searchDecisions`, remove it:
- Delete the function from `src/retrieval/query.ts` (lines 158–194).
- Remove from the barrel re-export in `src/retrieval/index.ts`.
- Verify the `SearchResult` interface has no other consumers; delete if orphaned.

Otherwise, leave it in place — only the CLI import changes.

### Phase 5 Validation Gate

```bash
npm run build 2>&1 | tee /tmp/ctx-build-p5.log
grep -c "error TS" /tmp/ctx-build-p5.log || echo "0 errors"
grep -n "queryDecisions\|Prior mistakes\|Active precedents" src/cli.ts
# Confirm retrieval import appears exactly once:
grep -c "^import.*from \"./retrieval/index.js\"" src/cli.ts
# Confirm searchDecisions is gone from cli.ts (it should NOT appear):
grep -c "searchDecisions" src/cli.ts || echo "0 (good)"
```

**Expected:** zero TS errors, full-pack rendering code visible, retrieval import appears exactly once, `searchDecisions` absent from `src/cli.ts`.

**STOP AND REPORT** — show the grep output. Commit: `feat(retrieval-mistakes): phase 5 — CLI renders full decision pack`.

---

## Phase 6 — Write-Tools Cleanup + MCP Tool Description

**Goal:** remove the dynamic `rejection_reason` cast (now that the field is typed) and update the `query_decisions` tool description.

### 6.1 Replace the dynamic cast in `src/mcp/write-tools.ts:258–262`

```ts
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
```

### 6.2 Update the `query_decisions` tool description in `src/mcp/read-tools.ts:11`

```ts
    "Retrieve relevant decision records for a file path, query, or scope. Returns a decision pack with prior mistakes in scope (antipatterns surfaced first), active precedents, abandoned approaches, recently superseded decisions, and pending inbox items.",
```

**MCP annotations — unchanged (Bucket 1 fix 1.7).** The annotations block at `src/mcp/read-tools.ts:24` MUST remain `{ readOnlyHint: true, destructiveHint: false, openWorldHint: false }`. Verify with:

```bash
grep -nA1 "readOnlyHint: true" src/mcp/read-tools.ts
```

**Expected:** the line `readOnlyHint: true, destructiveHint: false, openWorldHint: false` is byte-identical to pre-feature.

### Phase 6 Validation Gate

```bash
npm run build 2>&1 | tee /tmp/ctx-build-p6.log
grep -c "error TS" /tmp/ctx-build-p6.log || echo "0 errors"
grep -n "as unknown as Record" src/mcp/write-tools.ts
grep -n "prior mistakes\|Prior mistakes" src/mcp/read-tools.ts
```

**Expected:**
- Zero TS errors.
- The `as unknown as Record` cast line is gone.
- Tool description mentions prior mistakes.

**STOP AND REPORT** — confirm cast removal. Commit: `feat(retrieval-mistakes): phase 6 — typed rejection_reason + tool description`.

---

## Phase 7 — Smoke Tests

**Goal:** all 5 acceptance tests in `src/retrieval/smoke-test.ts` plus one end-to-end in `src/smoke.ts`. Follow the `makeDecision`/`makeTransition`/`appendToLedger` pattern from existing tests.

### 7.1 Five targeted tests in `src/retrieval/smoke-test.ts`

Add these at the bottom of the test list (follow existing `testN_...` naming, increment indices):

**Test A — superseded with pain_points:**
Seed one active decision (`precedent`, `confirmed_draft`) scoped to `domain/retrieval`. Seed another superseded decision in the same scope with a `supersede` transition containing `pain_points: ["leaked sessions"]`. Also seed the replacement decision referenced by `replaced_by`. Query by `scope_type: "domain"`, `scope_id: "retrieval"`. Assert:
- `pack.active_precedents.length === 1`
- `pack.mistakes_in_scope.length === 1`
- `pack.mistakes_in_scope[0].kind === "superseded_with_pain_points"`
- `(pack.mistakes_in_scope[0] as any).pain_points.includes("leaked sessions")`

**Test B — commit_inferred exclusion:**
Seed two abandoned decisions in scope `domain/retrieval`: one with `evidence_type: "backfill_confirmed"`, one with `evidence_type: "commit_inferred"`. Both have abandon transitions. Query. Assert:
- `pack.mistakes_in_scope.length === 1`
- the surviving entry is `kind: "abandoned"` and its `record.evidence_type === "backfill_confirmed"`.

**Test C — rejected inbox item intersects scope:**
Seed one active decision in scope `domain/retrieval` with a config `scope_mappings: {"src/retrieval/": {type: "domain", id: "retrieval"}}`. Write one dismissed inbox item to `inbox.jsonl` with `status: "dismissed"`, `rejection_reason: "out of scope for this release"`, `changed_files: ["src/retrieval/packs.ts"]`. Query by `file_path: "src/retrieval/packs.ts"`. Assert:
- `pack.mistakes_in_scope.length === 1`
- `pack.mistakes_in_scope[0].kind === "rejected_inbox_item"`
- `(pack.mistakes_in_scope[0] as any).rejection_reason === "out of scope for this release"`

**Test D — forced trim, Option A (active goes first, mistakes last):**
Seed many active decisions (e.g. 30 long-description ones) and 2 abandoned decisions with `pain_points`, all in scope `domain/retrieval`. Set `config.retrieval.token_budget = 800`. Query. Assert:
- `pack.truncated === true`
- `pack.mistakes_in_scope.length === 2` (survived as last casualty)
- `pack.active_precedents.length === 0` (fully trimmed — spec-literal Option A)
- `pack.abandoned_approaches.length === 0` (dropped entirely)

**Test E — feature_hint_mappings path populates mistakes:**
Write config with `feature_hint_mappings: { auth: ["auth"] }`. Seed an abandoned decision in scope `domain/auth` with pain_points. Query with `query: "how do we handle auth"` (no file_path, no scope_type). Assert:
- `pack.derived_scope?.id === "auth"`
- `pack.mistakes_in_scope.length === 1`
- `pack.mistakes_in_scope[0].kind === "abandoned"`

**Test H — recency fallback includes capped rejected inbox items (Q4):**
Seed 12 dismissed inbox items with `rejection_reason` and varied `rejected_at` timestamps. Do NOT seed any decisions. Query with NO `file_path`, NO `scope_type`, NO `query` (forces `derivedScope === null`). Assert:
- `pack.derived_scope === null`
- `pack.mistakes_in_scope.length === 10` (capped)
- All 10 entries have `kind === "rejected_inbox_item"`
- Sorted by `rejected_at` desc (verify first entry is the most recent)

### 7.2 Runner update

The existing runner at the bottom of `src/retrieval/smoke-test.ts` invokes each test in sequence. Add the new test calls (Tests A, B, C, D, E, F, G, H) there. Update the `dirs` accumulator pattern.

### 7.3 End-to-end test in `src/smoke.ts`

Add one test after the existing ones: seed a ledger with one abandoned decision, run `queryDecisions`, assert `pack.mistakes_in_scope.length === 1`. This protects the MCP → query → pack wiring.

### 7.4 Test F — Zero-Write Contract (Bucket 1 fix 1.10)

In `src/retrieval/smoke-test.ts`, add:

```ts
async function testF_zeroWriteContract(tmpDir: string): Promise<void> {
  console.error("\nTest F: queryDecisions writes nothing to disk");
  await writeConfig(tmpDir, {
    capture: { scope_mappings: {}, redact_patterns: [] },
    retrieval: { token_budget: 4000 },
  });

  const d1 = makeDecision({
    id: generateDecisionId(),
    evidence_type: "human_answered",
    durability: "precedent",
    scope: { type: "domain", id: "retrieval" },
  });
  await appendToLedger(d1, tmpDir);
  const t1 = makeTransition({ target_id: d1.id, action: "abandon", reason: "tried, failed", pain_points: ["oom"] });
  await appendToLedger(t1, tmpDir);

  const ledgerPath = join(tmpDir, ".context-ledger", "ledger.jsonl");
  const inboxPath = join(tmpDir, ".context-ledger", "inbox.jsonl");

  const ledgerBefore = await readFile(ledgerPath);
  let inboxBefore: Buffer | null = null;
  try { inboxBefore = await readFile(inboxPath); } catch { /* inbox may not exist yet */ }

  await queryDecisions({ scope_type: "domain", scope_id: "retrieval" }, tmpDir);

  const ledgerAfter = await readFile(ledgerPath);
  assert(ledgerBefore.equals(ledgerAfter), "ledger.jsonl unchanged after queryDecisions");

  if (inboxBefore) {
    const inboxAfter = await readFile(inboxPath);
    assert(inboxBefore.equals(inboxAfter), "inbox.jsonl unchanged after queryDecisions");
  }
}
```

Import `readFile` from `node:fs/promises` at the top of the test file (merge with existing import).

### 7.5 Test G — Response Shape Snapshot (Bucket 1 fix 1.11)

```ts
async function testG_responseShapeSnapshot(tmpDir: string): Promise<void> {
  console.error("\nTest G: pack response shape matches expected keys");
  await writeConfig(tmpDir, { capture: { scope_mappings: {} }, retrieval: { token_budget: 4000 } });

  const pack = await queryDecisions({ scope_type: "domain", scope_id: "empty" }, tmpDir);
  const keys = Object.keys(pack).sort().join(",");
  const expected = [
    "abandoned_approaches",
    "active_precedents",
    "derived_scope",
    "mistakes_in_scope",
    "no_precedent_scopes",
    "pending_inbox_items",
    "recently_superseded",
    "token_estimate",
    "truncated",
  ].join(",");
  assert(keys === expected, `pack keys match: got ${keys}`);
  assert(Array.isArray(pack.mistakes_in_scope), "mistakes_in_scope is an array");
}
```

Register Tests F and G in the runner at the bottom of the file.

### Phase 7 Validation Gate

```bash
npm run build
npm run smoke
```

**Expected:**
- `npm run build` — zero errors.
- `npm run smoke` — all prior tests still pass, plus the new ones (A–E + end-to-end). Exit 0.

If `npm run smoke` is not defined, run `node dist/retrieval/smoke-test.js && node dist/smoke.js`.

**STOP AND REPORT** — show smoke output with all assertions. Commit: `feat(retrieval-mistakes): phase 7 — smoke tests for mistakes_in_scope`.

---

## Phase 8 — Design Spec Update

**Goal:** extend `context-ledger-design-v2.md` to document the retrieval contract extension.

### 8.1 Locate the Retrieval section

Search for "Decision Pack Response" and "token_budget" in the spec. Add a new subsection titled `### mistakes_in_scope (added vN+1)` directly under the Decision Pack Response section.

### 8.2 Document the following exactly

Write prose in the spec's existing voice. Include:

1. **What it is.** "A dedicated array of antipatterns surfaced before active precedents, so token-truncated packs retain the highest-signal-per-token data (what not to do)."
2. **Three kinds.** Union members with field lists, mirroring §3.1 of exploration-results.md.
3. **Sources.** Populated entirely from the existing fold output + dismissed inbox items. No new events. No `DecisionRecord` / `TransitionEvent` schema changes. Call this out explicitly: **"This is a retrieval-contract extension. Event schemas (DecisionRecord, TransitionEvent) are untouched; the fold-logic audit confirms no event-schema change."**
4. **Exclusions.** `commit_inferred` records (weight 0.2) are excluded from `mistakes_in_scope` even in abandoned/superseded state. `feature-local` records excluded by default; pass `include_feature_local: true` to opt in (flag bypasses the existing feature-local filter globally).
5. **Trim priority — Option A, spec-literal (user-locked).** Document the sequence: `active_precedents` (from tail) → `recently_superseded` → `abandoned_approaches` → `pending_inbox_items` (cap, then pop) → `mistakes_in_scope` (last casualty). Cite the rationale: antipatterns are the irrecoverable signal under token pressure. A heavily truncated pack returns all mistakes and zero active precedents — this is intentional.
6. **Scope rules.** Same derivation paths as `active_precedents` (explicit, file_path via scope_mappings → scope_aliases → directory fallback, feature_hint_mappings, recency fallback). For rejected inbox items: `changed_files` must intersect the derived scope via the same derivation order (scope_mappings → scope_aliases → directory fallback); empty `changed_files` falls back to `commit_message` substring match. When `derivedScope === null` (recency fallback), include the N=10 most recent dismissed inbox items with `rejection_reason`, sorted by `rejected_at` desc.
7. **CLI render.** The `context-ledger query` command now calls `queryDecisions` (replacing `searchDecisions`) and renders the full decision pack. Mistakes are the first section; active precedents second.
8. **Tidy interaction.** Rejected-inbox mistakes are subject to the existing 30-day `tidyInbox` TTL. Dismissed items older than 30 days are removed and can no longer surface.

### 8.3 Separate decision: ratify `rejection_reason` as a typed `InboxItem` field

Add a distinct spec decision (not folded into the mistakes_in_scope entry). Proposed wording:

> **v2.4: `rejection_reason` promoted to typed optional field on `InboxItem`.** The field was previously persisted via an out-of-schema dynamic cast (`as unknown as Record<string, unknown>`) at `write-tools.ts:261`. This ratification promotes it to `rejection_reason?: string` on the documented `InboxItem` interface. Rationale: eliminates the ugly cast and lets the retrieval layer consume the field with full type safety. Not an event-schema change — `InboxItem` is a workflow queue entry, distinct from `DecisionRecord` / `TransitionEvent`. Append-only JSONL invariant applies to `ledger.jsonl` events; `inbox.jsonl` already uses atomic `rewriteInbox` for terminal-state transitions. Backward compatible: pre-ratification items written with the dynamic field parse correctly under the new typed interface (optional field, existing values persist).

Add this entry to the design-decisions table at the bottom of `context-ledger-design-v2.md` with attribution **"v2.4: Arbiter (user triage, council pass 1)"**.

### 8.4 Update the `query_decisions` param table

Add a row:
- `include_feature_local | bool | false | Opt in to feature-local durability records across all sections. Bypasses the default feature-local filter globally.`

### 8.5 Update the Decision Pack Response schema block

Add `"mistakes_in_scope": [...]` to the sample JSON response immediately after `"recently_superseded"`. Add a comment line: `// Antipatterns surfaced first under token pressure (Option A trim order)`.

### Phase 8 Validation Gate

```bash
grep -n "mistakes_in_scope" context-ledger-design-v2.md
grep -n "include_feature_local" context-ledger-design-v2.md
grep -n "retrieval-contract extension" context-ledger-design-v2.md
grep -n "rejection_reason" context-ledger-design-v2.md
grep -n "v2.4" context-ledger-design-v2.md
```

**Expected:** all five present. `rejection_reason` appears in the ratification decision entry.

**STOP AND REPORT** — show grep output. Commit: `docs(spec): mistakes_in_scope retrieval contract + rejection_reason ratification`.

---

## Phase 9 — Documentation Sync + Final Validation

### 9.1 Run agent-guard sync

```bash
npx agent-guard sync
```

Review its proposed doc changes. If it updated `docs/ARCHITECTURE.md` sections that describe retrieval/MCP, confirm the diff is accurate and stage it. The CLAUDE.md Documentation Maintenance section says: for `src/*` changes, update the Architecture section in `docs/ARCHITECTURE.md` in the same session.

If agent-guard's hook is in blocking mode, docs MUST be up to date before you can commit. Read the changed source files, update `docs/ARCHITECTURE.md` manually if needed, `git add`, retry commit. Do NOT run `npx agent-guard sync` to try to auto-fix — CLAUDE.md explicitly forbids this pattern for AI-triggered commits.

### 9.2 Final build + smoke + hook check

```bash
npm run build
npm run smoke
# Hot-path no-op verification (Bucket 1 fix 1.8)
git diff --stat src/capture/ | wc -l       # must be 0
git diff --stat scripts/post-commit.* 2>/dev/null | wc -l  # must be 0
# Also check that agent-guard sync did not modify capture paths
git status --porcelain src/capture/ scripts/post-commit.* 2>/dev/null | wc -l  # must be 0
grep -c "console.log" src/index.ts 2>/dev/null || echo "no console.log (good)"
```

**Expected:**
- Build passes. Smoke passes.
- `src/capture/` untouched.
- Post-commit hook untouched.
- No `console.log` in `src/index.ts` (MCP stdio reserved for JSON-RPC).

### 9.3 Manual verification

From a scratch directory:

```bash
# Build once
npm run build

# Seed a throwaway ledger with an abandoned decision + supersede with pain_points
# (use the smoke-test helpers or hand-write JSONL)
node -e "/* seed a .context-ledger/ledger.jsonl in a tmp dir */"

# Run the CLI query against that dir
./dist/cli.js query "retrieval" --project-root /tmp/ledger-manual
```

Confirm the "Prior mistakes in this scope" section appears before active results.

### 9.4 Final commit + PR prep

Commit: `feat(retrieval-mistakes): phase 9 — docs sync and final validation`.

Then prepare a summary PR description that:
- Links to this implementation guide.
- Summarizes the eight prior phase commits.
- Calls out: zero event schema changes, zero hook changes, zero runtime dependencies added.
- Includes sample `query_decisions` output showing the new section.

**STOP AND REPORT** — share build/smoke output and the PR description. Wait for user go-ahead to push.

---

## Appendix A — Invariants Checklist (verify at every STOP AND REPORT)

- [ ] JSONL append-only — this feature writes nothing to `ledger.jsonl` or `inbox.jsonl`.
- [ ] Post-commit hook untouched — `src/capture/` has zero diff.
- [ ] Fold logic untouched — `src/ledger/fold.ts` has zero diff.
- [ ] Event schema untouched — `DecisionRecord`, `TransitionEvent` unchanged; only `InboxItem` gains one optional field.
- [ ] All imports use `.js` extensions.
- [ ] MCP annotations on `query_decisions` preserved: `readOnlyHint: true, destructiveHint: false, openWorldHint: false`.
- [ ] Zero new runtime dependencies.
- [ ] `commit_inferred` (weight 0.2) excluded from `mistakes_in_scope`.
- [ ] `feature-local` excluded by default; `include_feature_local: true` opts in.
- [ ] `superseded` remains terminal — this feature reads `pain_points` but never writes transitions.

## Appendix B — Rollback

This feature is strictly additive. To revert:

```bash
git revert <phase-9-sha>..<phase-1-sha>
```

All nine commits are reversible in one sequence. No data migration. `inbox.jsonl` items written with typed `rejection_reason` remain readable by pre-feature code because the field was previously dynamic.

---

## Appendix C — Refinement Log

**Council review pass 1** (Gemini 3.1 Pro + Codex gpt-5.4) produced `council-feedback.md`. Triage in `triage-results.md`. 13 Bucket 1 fixes applied autonomously to this guide:

1. **Fix 1.1 (Phase 2.2):** Added dedup step — records in `mistakes_in_scope` are removed from `abandoned_approaches` and `recently_superseded` to prevent token budget double-counting.
2. **Fix 1.2 (Phase 3.2):** `inboxItemIntersectsScope` now scans `scope_aliases[]` on active decisions (mirrors `scope.ts:65–73`).
3. **Fix 1.3 (Phase 5):** CLI render replaced `if/else` with exhaustive `switch(m.kind) { ... default: assertNever }`.
4. **Fix 1.4 (Phase 1):** Added `grep -rn ": DecisionPack" src/ | grep -v packs.ts | wc -l` to validation gate (must be 0).
5. **Fix 1.5 (Phase 3.2):** Empty `changed_files` falls back to `commit_message` substring match against `scope.id`.
6. **Fix 1.6 (Phase 3.3):** Clarified rejected inbox items are not filtered by durability (durability is a `DecisionRecord` field, not an `InboxItem` field).
7. **Fix 1.7 (Phase 6.2):** Explicit `readOnlyHint: true` annotation-unchanged check added.
8. **Fix 1.8 (Phase 9.2):** Added hot-path no-op verification — `git status --porcelain src/capture/ scripts/post-commit.*` must show zero lines after `agent-guard sync`.
9. **Fix 1.9 (Phase 1 & 8):** Documented that no Zod response schema exists — response-shape change is implicit via `DecisionPack` TS interface only.
10. **Fix 1.10 (Phase 7.4):** Added Test F — zero-write contract (compares ledger/inbox bytes pre/post query).
11. **Fix 1.11 (Phase 7.5):** Added Test G — response-shape snapshot.
12. **Fix 1.12 (Phase 3.2):** Helper now explicitly comments that it mirrors `scope.ts:31–102` and must be updated in lockstep.
13. **Fix 1.13 (Phase 2.2):** `commit_inferred` exclusion-asymmetry rationale added as code comment.

**Council pass 1 Bucket 2 resolutions (user triage, 2026-04-19):**

14. **Q1 → Phase 4.1:** Trim order rewritten to Option A (spec-literal): `active_precedents` trimmed from tail FIRST, then `recently_superseded`, then `abandoned_approaches`, then `pending_inbox_items` (cap + pop), and `mistakes_in_scope` is the last casualty. Test D updated to assert `active_precedents.length === 0` under heavy pressure.
15. **Q2 → Phase 1.1 + Phase 6.1 + Phase 8.3:** `rejection_reason` ratified as typed optional field on `InboxItem`. Dynamic cast removed. Phase 8 now records this as a separate spec decision (v2.4), not folded into the mistakes_in_scope entry.
16. **Q3 → Phase 5.1 + Phase 5.2:** CLI `query` now calls `queryDecisions` exclusively and renders the full decision pack (mistakes first, then active, abandoned, superseded, inbox). `searchDecisions` may be deleted if grep confirms zero consumers.
17. **Q4 → Phase 3.3:** Recency fallback (`derivedScope === null`) now includes the N=10 most recent dismissed inbox items with `rejection_reason`, sorted by `rejected_at` desc. Added Test H to verify cap + sort.

**Bucket 2 cleared. Guide is ready to execute.**

---

## Appendix D — Human Input Gate (RESOLVED — council pass 1 triage)

All four Bucket 2 questions answered by the user. Guide updated accordingly.

| Q | Decision | Applied in |
|---|----------|-----------|
| Q1 | **Option A** — spec-literal trim: active from tail → recently_superseded → abandoned_approaches → pending_inbox_items (cap + pop) → mistakes_in_scope last | Phase 4.1 |
| Q2 | **Ratify** — `rejection_reason` promoted to typed optional field on `InboxItem`; dynamic cast removed | Phase 1.1, Phase 6.1, Phase 8.3 (separate spec decision) |
| Q3 | **Replace** — `searchDecisions` swapped for `queryDecisions` in CLI; full decision pack rendered | Phase 5.1, Phase 5.2 (optional cleanup) |
| Q4 | **Include capped at N=10** — recency fallback returns top 10 most recent dismissed inbox items with `rejection_reason` sorted by `rejected_at` desc | Phase 3.3 |

Guide is now ready for a fresh Claude Code session to execute end-to-end.
