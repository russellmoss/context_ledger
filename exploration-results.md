# Exploration Results: `mistakes_in_scope` in Decision Pack

Synthesizes findings from `code-inspector-findings.md` and `pattern-finder-findings.md`. Every claim below is backed by a file:line reference. Design spec consulted: `context-ledger-design-v2.md`.

---

## 1. Pre-Flight Summary

Adding `mistakes_in_scope` is a **retrieval-only, read-path** extension. No new events, no fold changes, no hook touch, no LLM calls. The feature surfaces three existing data sources (superseded pain_points, abandoned reasons, dismissed inbox items with rejection_reason) that the fold already captures but the pack builder drops. Single construction site (`packs.ts:117`) means TypeScript will enforce coverage. Main risks: (a) spec's trim order inverts current priority (active trimmed first, mistakes last) — significant behavior change, needs explicit confirmation; (b) `rejection_reason` is an out-of-schema dynamic field on `InboxItem` — must promote to typed optional field; (c) CLI `query` currently uses `searchDecisions`, not `queryDecisions` — switching or dual-calling is required to render the new section; (d) `include_feature_local` is a new param not defined in spec v2 — interaction with existing feature-local filter must be resolved.

---

## 2. Files to Modify

| File | Change |
|------|--------|
| `src/retrieval/packs.ts` | Add `MistakeEntry` type + `mistakes_in_scope` field on `DecisionPack`; populate in `buildDecisionPack`; rewrite trim order |
| `src/retrieval/query.ts` | Add `include_feature_local` to `QueryDecisionsParams`; gate feature-local filter on it; pass dismissed inbox items to pack builder |
| `src/retrieval/index.ts` | Re-export `MistakeEntry` |
| `src/retrieval/scope.ts` | Add helper: given a set of `changed_files` and a `DerivedScope`, does any file resolve into the scope? (used for rejected-inbox filter) |
| `src/ledger/events.ts` | Promote `rejection_reason?: string` to typed optional field on `InboxItem` |
| `src/ledger/index.ts` | No change (re-exports are already wildcard for events) — verify |
| `src/mcp/write-tools.ts` | Remove the `as unknown as Record<string, unknown>` cast for `rejection_reason` once the field is typed (line 261) |
| `src/mcp/read-tools.ts` | Update `query_decisions` tool description string to mention mistakes surfacing |
| `src/cli.ts` | Switch `handleQuery` (or add a second path) to call `queryDecisions` and render a "Prior mistakes in this scope" section before active precedents |
| `src/smoke.ts` | Add one end-to-end mistakes_in_scope test |
| `src/retrieval/smoke-test.ts` | Add ≥5 targeted tests (see Acceptance Tests in the feature spec) |
| `context-ledger-design-v2.md` | Extend the Retrieval section: document `mistakes_in_scope`, the new trim priority, `include_feature_local` param, and call out explicitly that this is a retrieval-contract extension with zero schema/event changes |

---

## 3. Type Changes

### 3.1 New `MistakeEntry` union in `src/retrieval/packs.ts`

Three source kinds → one discriminated union. Use `kind` as the discriminator so CLI/agent rendering can switch cleanly:

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
      rejected_at: string; // ISO 8601
    };
```

Note: `AbandonedEntry` currently drops the abandon transition's `reason` string (packs.ts:75–81). `MistakeEntry.abandoned` surfaces it; `AbandonedEntry` remains unchanged to preserve backward compatibility of `abandoned_approaches`.

### 3.2 `DecisionPack` gains one field (packs.ts:31–40)

```ts
export interface DecisionPack {
  derived_scope: DerivedScope | null;
  active_precedents: PackEntry[];
  abandoned_approaches: AbandonedEntry[];
  recently_superseded: SupersededEntry[];
  pending_inbox_items: InboxItem[];
  mistakes_in_scope: MistakeEntry[];     // ← new, render order: first in CLI
  no_precedent_scopes: string[];
  token_estimate: number;
  truncated: boolean;
}
```

### 3.3 `InboxItem` gets typed `rejection_reason`

In `src/ledger/events.ts:88–103`:

```ts
export interface InboxItem {
  // ... existing fields
  rejection_reason?: string;  // ← promoted from dynamic any-cast
}
```

This eliminates the `(updated as unknown as Record<string, unknown>).rejection_reason = args.reason` cast in `write-tools.ts:261`.

### 3.4 `QueryDecisionsParams` gets `include_feature_local`

In `src/retrieval/query.ts:15–26`:

```ts
export interface QueryDecisionsParams {
  // ... existing fields
  include_feature_local?: boolean; // default: false
}
```

### 3.5 MCP `query_decisions` Zod schema

In `src/mcp/read-tools.ts:12–23`: add `include_feature_local: z.boolean().optional().describe("Include feature-local durability records in mistakes_in_scope and elsewhere. Default false.")`.

---

## 4. Construction Site Inventory

Exactly **one** construction site for `DecisionPack`:
- `src/retrieval/packs.ts:117–126` — the sole object literal. TypeScript will error on every path if `mistakes_in_scope` is missing.

Exactly **one** construction site for `InboxItem` with `rejection_reason`:
- `src/mcp/write-tools.ts:258–262` — the dynamic-cast write path. Becomes a typed assignment.

Barrel re-exports to update:
- `src/retrieval/index.ts:7` — add `MistakeEntry` to the type re-export list.
- `src/ledger/index.ts` — verify `InboxItem` is re-exported; if not, no action needed (consumers import from `../ledger/index.js`).

Read sites (no type error; must hand-update):
- `src/mcp/read-tools.ts:11,28` — tool description string and JSON.stringify path. No type impact.
- `src/cli.ts:133–162` — CLI rendering. Must add a render branch for each `MistakeEntry.kind`.
- `src/retrieval/smoke-test.ts` — existing tests that JSON.stringify the pack will now include `mistakes_in_scope: []`. Snapshot assertions (if any) need updating; none exist today per pattern-finder findings.

---

## 5. Recommended Phase Order

Each phase ends with `npm run build` + targeted smoke run. Agent-guard sync after final validation.

1. **Phase 1 — Types only.** Add `MistakeEntry` union, extend `DecisionPack`, add `rejection_reason` typed field to `InboxItem`, add `include_feature_local` to `QueryDecisionsParams` and MCP Zod schema, add empty array initialization to the pack construction site. Re-export `MistakeEntry`. Build passes; smoke tests still pass (empty array renders as `[]`). Commit.
2. **Phase 2 — Pack builder logic.** Inside `buildDecisionPack`, classify folded decisions into the three `MistakeEntry` kinds. Respect commit_inferred exclusion (evidence_type check). Respect `include_feature_local` flag. Sort by `record.created` desc. Accept rejected inbox items as a new parameter. Build passes; targeted test proves classification works. Commit.
3. **Phase 3 — Query.ts orchestration.** Extend `queryDecisions` to read dismissed inbox items, scope-intersect their `changed_files` against `derivedScope`, pass filtered list to `buildDecisionPack`. Apply `include_feature_local` flag to the existing feature-local filter at query.ts:72–78. Commit.
4. **Phase 4 — Trim order rewrite.** Rewrite the trim block (packs.ts:130–157) per the new priority. Explicit comment citing the spec rationale. Update the `context-ledger:` stderr log to reflect new order. Commit.
5. **Phase 5 — CLI rendering.** Switch `handleQuery` to call `queryDecisions` (not `searchDecisions`) OR add a paired call. Render "Prior mistakes in this scope" section before active precedents. One render branch per `MistakeEntry.kind`. Commit.
6. **Phase 6 — MCP write-tools cleanup.** Remove the `as unknown as Record<string, unknown>` cast now that the field is typed. Tool description update. Commit.
7. **Phase 7 — Tests.** All five acceptance tests in `src/retrieval/smoke-test.ts`; one end-to-end in `src/smoke.ts`. Run `npm run build && npm run smoke`. Commit.
8. **Phase 8 — Design spec update.** Extend the Retrieval section of `context-ledger-design-v2.md`: document `mistakes_in_scope`, the new trim priority, `include_feature_local`, and call out explicitly that this is a retrieval-contract extension with zero schema/event changes. Commit.
9. **Phase 9 — Agent-guard sync.** `npx agent-guard sync`. Final commit.

---

## 6. Risks and Blockers

### 6.1 Trim-order inversion is a significant behavior change — DESIGN QUESTION

The feature spec says:

> Token-budget trim order: `active_precedents` → `superseded_history` → `abandoned_approaches` → `pending_inbox_items` → `mistakes_in_scope` LAST. Mistakes survive trimming when peers do not.

Taken literally (with "LAST" as anchor), this means `active_precedents` gets trimmed **first** — the opposite of current behavior (packs.ts:149–152 trims active last, from tail). Under token pressure on a hot scope, a query would return all mistakes and zero active precedents. This may be intentional (the rationale — "antipatterns are highest-signal-per-token for preventing repeats" — supports it), but it reverses years of "give the agent the current state first" intuition.

**Options:**
- (A) Spec-literal: trim `active_precedents` first from the tail (lowest-weight first), preserve mistakes intact. Maintains the intent "mistakes are the signal that must not be lost."
- (B) Conservative compromise: keep active trimmed last as today, but insert mistakes into the trim order **before** pending inbox items and **after** abandoned (so mistakes survive abandoned/superseded being dropped but yield to active). This preserves current active-is-last behavior while still elevating mistakes above its neighbors.
- (C) Hybrid: trim active from the tail one-at-a-time (current behavior), but preserve the top-N most recent mistakes regardless of cost. Requires a cap constant on mistakes.

**Recommendation:** Flag for human input before Phase 4. Council review may also weigh in.

### 6.2 `include_feature_local` interaction with existing feature-local filter

The spec says:

> Feature-local durability excluded by default. Include only when `include_feature_local: true`.

The existing filter at query.ts:72–78 already excludes `feature-local` records **unless** the query includes a `file_path` that exactly matches an entry in `affected_files`. Two compatibility options:

- (A) `include_feature_local: true` short-circuits the existing filter entirely (all feature-local records pass through for all sections). Simplest.
- (B) `include_feature_local: true` bypasses the filter **only for mistakes_in_scope classification**, leaving active_precedents feature-local filtering unchanged. More surgical but harder to reason about.

**Recommendation:** Option (A). One flag, one behavior. Flag for human input.

### 6.3 CLI `handleQuery` currently uses `searchDecisions`, not `queryDecisions`

The feature spec says to render "Prior mistakes in this scope" in `context-ledger query` output. The CLI command currently uses lexical `searchDecisions` (active-only, no pack). Rendering mistakes requires calling `queryDecisions`. Two options:

- (A) Replace `searchDecisions` with `queryDecisions`. Preserves the mistakes section but changes CLI output for all queries (now shows a full pack, not just matches).
- (B) Call both: `searchDecisions` for active matches (preserving current CLI behavior) + `queryDecisions` for the mistakes section only (rendered first).

**Recommendation:** Option (B). Preserves existing UX; adds only the new section. Flag for human input.

### 6.4 Rejected inbox items may be tidied before `mistakes_in_scope` can surface them

`tidyInbox` (ledger/inbox.ts:36–40) deletes terminal inbox entries (`dismissed`/`expired`/`ignored`) older than 30 days (per CLAUDE.md). If a user runs `context-ledger tidy` routinely, rejected items older than 30 days disappear and cannot appear in `mistakes_in_scope`.

**Resolution:** Accept this. The 30-day tidy window is a durability choice, not a retrieval bug. Document in the spec update that rejected-inbox mistakes are subject to tidy TTL.

### 6.5 Recency fallback (`derivedScope === null`) has no scope to intersect

When scope derivation returns null, there is nothing to intersect rejected-inbox `changed_files` against. Two options:

- (A) In recency fallback, omit rejected inbox items from `mistakes_in_scope` entirely. The section still includes abandoned/superseded mistakes from the broad fallback set.
- (B) In recency fallback, include all dismissed inbox items with a `rejection_reason`, sorted by `rejected_at` desc, capped at some small N (e.g. 10).

**Recommendation:** Option (A). Recency fallback is already a last-resort path; adding unscoped rejected items adds noise. Documented in spec.

### 6.6 Design spec v2 says "47 traced design decisions from 4 rounds of adversarial review"

This feature adds a retrieval-contract extension. It should be added as a new decision in the spec, not replace anything. The existing Decision Pack Response schema in CLAUDE.md:170 is the shape this feature extends.

### 6.7 `commit_inferred` exclusion needs explicit enforcement

Today, the `evidence_type === "commit_inferred"` records (weight 0.2) can appear in `abandoned_approaches` and `recently_superseded` because no filter excludes them. The feature spec says:

> `commit_inferred` records (retrieval_weight 0.2) are excluded from `mistakes_in_scope` even in abandoned/superseded state — unreviewed inferences never drive agent behavior, including as antipatterns.

**Implementation:** In the classification loop for `MistakeEntry` population, add explicit `if (folded.record.evidence_type === "commit_inferred") continue;`. Do **not** add it to the existing `abandoned_approaches` / `recently_superseded` classification — the spec explicitly limits this exclusion to `mistakes_in_scope`.

### 6.8 Existing `AbandonedEntry` drops abandon transition `reason`

Pattern-finder flagged that `AbandonedEntry` (packs.ts:19–23) only carries `pain_points`, not the abandon transition's `reason`. `MistakeEntry.abandoned` captures `reason`. Do **not** change `AbandonedEntry` in this feature — it's a potential future improvement, out of scope here.

---

## 7. Design Spec Compliance

Verified against `context-ledger-design-v2.md` (plus the Quick Reference in `CLAUDE.md`):

| Spec assertion | Feature compliance |
|----------------|---------------------|
| JSONL append-only | PASS — Feature reads fold output only. Zero writes. |
| Post-commit hook <100ms, zero LLM, zero network | PASS — Cold-path retrieval only. Hook untouched. |
| Lifecycle state machine: `superseded` terminal | PASS — Feature surfaces `pain_points` from supersede but never reopens or mutates. |
| Auto-promotion threshold (>= 0.7 + precedent + active) | PASS — Untouched. `commit_inferred` (0.2) explicitly excluded from mistakes. |
| Evidence types → retrieval weight table | PASS — Respected via `commit_inferred` exclusion. |
| Durability: feature-local default-excluded | PASS — New `include_feature_local` flag defaults to false; default behavior preserved. |
| Decision Pack Response schema (CLAUDE.md:170) | EXTEND — Adds `mistakes_in_scope` field. Spec update required (Phase 8). |
| `query_decisions` MCP tool param table | EXTEND — Adds `include_feature_local` param. Spec update required (Phase 8). |
| Token budget 4000, trim order | EXTEND — Trim order changes. Spec update required (Phase 8). Highest-risk spec touch. |
| MCP annotations (readOnlyHint, destructiveHint, openWorldHint) | PASS — Read tool; annotations unchanged. |
| Zero runtime dependencies added | PASS — No new dependencies. |
| `.js` import extensions, Node16 resolution | PASS — All new imports follow convention. |
| Idempotent writes (`client_operation_id`) | PASS — No writes in this feature. |
| Event schema unchanged | PASS — No event schema touches. `rejection_reason` is an `InboxItem` field, not an event field; inbox items are not events. |

**North-star check (from feature request):** This feature moves the ledger up autonomy axis #1 (retrieval quality) without touching auto-promotion. Strictly additive to the retrieval contract, reversible by reverting the retrieval module.
