# Triage Results — `mistakes_in_scope` Council Feedback

Each council item is bucketed. Bucket 1 applied to the implementation guide now. Bucket 2 surfaced to the user.

---

## Bucket 1 — APPLY AUTONOMOUSLY

These fixes match the codebase/spec unambiguously and will be applied to `agentic_implementation_guide.md` without user input.

| # | Item | Action |
|---|------|--------|
| 1.1 | **Token budget double-counting.** Superseded/abandoned records promoted to `mistakes_in_scope` were also left in `abandoned_approaches` / `recently_superseded`, doubling their token cost. | Update Phase 2.2: after classification, remove any record from `abandoned_approaches` and `recently_superseded` whose `record.id` matches one in `mistakes_in_scope`. Explicit dedup code added. |
| 1.2 | **`inboxItemIntersectsScope` missing `scope_aliases`.** | Update Phase 3.2: add a third branch that scans active decisions' `scope_aliases[]` for prefix match against each `changed_files` entry, mirroring `scope.ts:65–73`. |
| 1.3 | **Non-exhaustive discriminated union in CLI.** | Update Phase 5.1: replace `if/else if/else` with `switch(m.kind) { ... default: const _: never = m; throw new Error(...); }`. |
| 1.4 | **"Single construction site" grep check.** | Update Phase 1 validation gate: add `grep -rn ": DecisionPack" src/ \| grep -v packs.ts \| wc -l` → must be `0`. |
| 1.5 | **Scope intersection too narrow — fallback for empty `changed_files`.** | Update Phase 3.2: if item.`changed_files` is empty, fall back to `commit_message` substring match against `scope.id`. |
| 1.6 | **`include_feature_local` not plumbed to rejected-inbox path.** | Update Phase 3.3 prose: explain rejected inbox items are not filtered by durability because inbox items don't carry durability — durability is a `DecisionRecord` field. |
| 1.7 | **MCP annotations unchanged statement.** | Update Phase 6.2: add explicit assertion that `{ readOnlyHint: true, destructiveHint: false, openWorldHint: false }` remains identical. |
| 1.8 | **Hot-path no-op verification after agent-guard sync.** | Update Phase 9.1: after `npx agent-guard sync`, run `git diff --stat src/capture/ scripts/post-commit.*` and assert zero lines. Add to validation gate. |
| 1.9 | **MCP response contract — explicit note that no Zod response type exists.** | Update Phase 1.7 and Phase 8: add sentence "MCP response is `JSON.stringify(pack, null, 2)` — no Zod response schema exists, so the response-shape change is implicit via the `DecisionPack` TS interface." |
| 1.10 | **Zero-write contract test.** | Add to Phase 7: new Test F that records mtime of `ledger.jsonl` and `inbox.jsonl`, runs `queryDecisions`, asserts files are byte-identical. |
| 1.11 | **Response-shape snapshot test.** | Add to Phase 7: new Test G that snapshots `pack` shape with populated `mistakes_in_scope` and empty variants. Snapshot stored inline as string literal comparison. |
| 1.12 | **Phase 3 helper drift risk.** | Update Phase 3.2: prefix the helper with a comment citing `scope.ts:31–102` and note that any future change to `deriveScope` must update this helper in lockstep. |
| 1.13 | **`commit_inferred` exclusion asymmetry — document explicitly.** | Update Phase 2.2: add a comment explaining the asymmetry: `commit_inferred` remains in `abandoned_approaches` / `recently_superseded` as context but is excluded from `mistakes_in_scope` because mistakes actively shape agent behavior (do-not-repeat) while the legacy buckets are informational only. |

---

## Bucket 2 — NEEDS HUMAN INPUT

Four items require explicit user decisions. These block Phase 4 (trim-order), Phase 6 (schema change), Phase 5 (CLI), and recency-fallback behavior. Surface them to the user now.

### Q1: Trim order — Option A (spec-literal) or Option B (current default)?

**Context.** The feature request literally says:

> Token-budget trim order: `active_precedents` → `superseded_history` → `abandoned_approaches` → `pending_inbox_items` → `mistakes_in_scope` LAST. Mistakes survive trimming when peers do not.

Both reviewers independently said the plan's Option B (preserve active-last, trim mistakes before active) violates the literal spec. The literal reading (Option A) is: when the pack is over budget, drop `active_precedents` from the tail first, then peel off `recently_superseded`, then `abandoned_approaches`, then cap `pending_inbox_items`, and only trim `mistakes_in_scope` as a last resort.

**Trade-offs:**
- **Option A (spec-literal).** Matches the user's explicit intent — "antipatterns are the highest-signal-per-token data." A heavily truncated pack returns all mistakes and zero active precedents. Philosophical bet: "don't do this" is more valuable than "do this" under token pressure.
- **Option B (preserve active-last).** Keeps the current behavior of active_precedents being the last casualty. Ensures the agent always has current-state guidance; mistakes yield to active when tokens are tight. More conservative.

**Reviewers:** Both say Option A.

**Question:** Go with Option A (spec-literal) or keep Option B?

---

### Q2: Ratify `rejection_reason` as a typed `InboxItem` field, or keep it dynamic?

**Context.** Today `rejection_reason` is written at `write-tools.ts:261` via `(updated as unknown as Record<string, unknown>).rejection_reason = args.reason` — an out-of-schema dynamic field. The plan's Phase 1 + Phase 6 promote it to `rejection_reason?: string` on the `InboxItem` interface and replace the cast with a typed spread.

This **is** a schema change, which the feature description said should not happen ("no new events, no schema changes, no LLM calls"). But arguably `InboxItem` is not an *event* — events are `DecisionRecord` and `TransitionEvent`. Inbox items are workflow queue entries. The spec's literal prohibition was against event-schema changes.

**Trade-offs:**
- **Ratify (keep Phase 1 + Phase 6 as-is).** Eliminates the ugly cast. Adds `rejection_reason` to the documented InboxItem schema so future code uses it correctly. Reviewers agree this is the right long-term move. Requires calling it out explicitly in the Phase 8 spec update as a separate decision.
- **Keep dynamic.** Drop Phase 6. In Phase 2/Phase 3, read via a narrow read-side cast: `(item as InboxItem & { rejection_reason?: string }).rejection_reason`. Strictly preserves the feature's "retrieval-only" framing but leaves the existing cast in place.

**Reviewers:** Both accept Ratify if documented as an intentional schema decision.

**Question:** Ratify `rejection_reason` as a typed field (with explicit spec update), or keep it dynamic and add a read-side cast?

---

### Q3: CLI — dual-call (current) or replace `searchDecisions` with `queryDecisions`?

**Context.** `context-ledger query <query>` today uses `searchDecisions` (active-only lexical match). The plan's Option B renders mistakes via a separate `queryDecisions` call, keeping the lexical search output unchanged. Both reviewers dislike this: two calls, potential mismatched scope between sections, extra fold/pack work. Alternative is to replace `searchDecisions` entirely with `queryDecisions` and render the full pack.

**Trade-offs:**
- **Dual-call (Option B).** Preserves existing CLI UX; mistakes render as a new section *above* existing output. Two fold/pack passes per invocation.
- **Replace with queryDecisions.** One retrieval call. Output changes shape — now shows the full decision pack (active precedents, abandoned approaches, etc.), not just lexical matches. Strictly more informative but also more verbose.

**Reviewers:** Replace with `queryDecisions`.

**Question:** Dual-call, or replace `searchDecisions` with `queryDecisions`?

---

### Q4: Recency fallback — omit rejected inbox items or include capped at N=10?

**Context.** When scope derivation returns null (no file_path, no scope params, no feature_hint match), the plan omits rejected inbox items entirely. The feature request says "apply to every scope-derivation path." Reviewers flagged this as a silent spec deviation.

**Options:**
- **Omit (plan default).** Safe. Matches current plan.
- **Include all recent dismissed items, capped at N=10, sorted by `rejected_at` desc.** Honors the "every scope-derivation path" instruction.

**Reviewers:** Include capped at N=10.

**Question:** Omit, or include capped at N=10?

---

## Bucket 3 — NOTE BUT DON'T APPLY

- **Naming debate (mistakes_in_scope vs prior_mistakes vs known_antipatterns).** User explicitly chose `mistakes_in_scope` in the feature request. Do not override without explicit user instruction.
- **Granular `include_feature_local` (by feature slug).** Out of scope for v1. File as a future improvement.
- **CLI color coding.** Low-priority polish. Do not add ANSI wrapping in this feature.
- **Tidy TTL extension for rejected inbox items.** Reviewer suggestion to upgrade dismissed items to "precedent" durability. Too large a scope change; the 30-day tidy window is an intentional durability choice per CLAUDE.md / spec.
- **Agent-guard conflict surface annotation.** Ecosystem-level concern, not a retrieval-tool concern.

---

## Summary

- **13 Bucket 1 fixes** — will be applied to `agentic_implementation_guide.md` autonomously.
- **4 Bucket 2 questions** — block Phase 4, Phase 6, Phase 5, and recency-fallback behavior. Waiting for user input.
- **5 Bucket 3 items** — noted, not applied.
