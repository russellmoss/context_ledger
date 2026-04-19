# Council Feedback — `mistakes_in_scope`

Two reviewers consulted: **Gemini 3.1 Pro** (via ask_gemini) and **Codex gpt-5.4** (via ask_codex). Gemini focused on spec compliance and DX; Codex focused on type safety, schema integrity, and phase ordering. Findings are merged, deduplicated, and annotated with convergence signal.

Legend: **[BOTH]** both reviewers flagged; **[C]** only Codex; **[G]** only Gemini.

---

## CRITICAL

- **[BOTH] Trim-order inversion is semantically wrong.** Phase 0 + Phase 4 adopt Option B (trim `recently_superseded` → `abandoned_approaches` → `mistakes_in_scope` → active_precedents from tail, and leave `pending_inbox_items` untouched). The literal feature request says "active_precedents → superseded_history → abandoned_approaches → pending_inbox_items → mistakes_in_scope LAST. Mistakes survive trimming when peers do not." Option B trims abandoned and superseded peers **before** mistakes, so mistakes do survive their direct peers, but `active_precedents` still survives longer than mistakes — the literal phrase "mistakes LAST" is broken. Additionally, Phase 4 leaves `pending_inbox_items` completely untrimmable, which can blow the token budget. **Codex and Gemini both say: go with Option A (spec-literal) — active trimmed first from the tail, pending_inbox_items added to the trim order, mistakes genuinely last.**

- **[BOTH] Phase 1 + Phase 6 change the inbox schema and write path.** The feature description mandates "no new events, no schema changes, no LLM calls." Phase 1 formalizes `InboxItem.rejection_reason?: string` (a schema extension) and Phase 6 rewrites the `reject_pending` write path (`src/mcp/write-tools.ts:261`) to persist it via typed spread. That is **both** a schema change and a write-path change, hidden inside a retrieval-only feature. Two options: (a) drop the Phase 1 schema change and the Phase 6 cleanup entirely — consume the dynamic field via a narrow read-side cast only; (b) accept the schema change as an intentional ratification of the existing out-of-schema field but call it out as a separate decision and spec update, not buried in this feature.

- **[BOTH] Recency fallback silently drops a mandated source.** The request says "Apply to every scope-derivation path: explicit scope params, file_path-derived, feature_hint_mappings, and recency fallback." Phase 3 explicitly omits rejected inbox items when `derivedScope === null` (recency fallback). That silently violates the feature contract. Must at least surface the N most recent rejected inbox items with their `changed_files` listed as context, even without scope intersection — or explicitly document why recency fallback is an exception and get user sign-off.

- **[G] Token budget double-counting.** The Phase 2 classification loop maps superseded/abandoned decisions into `mistakes_in_scope` **while also leaving them in** `abandoned_approaches` and `recently_superseded` (the existing arrays are built by the pre-existing classification block, which wasn't touched). This doubles the token cost for every such record and triggers premature trimming. Either the classification block must skip records promoted to mistakes, or the entry types should share structure so the promotion is a shallow move. Phase 2 section 2.2 does not address this.

- **[C] MCP response contract is underspecified.** The plan updates `QueryDecisionsParams` and the MCP Zod **input** params, and updates the tool description string, but never names the explicit file or section where the MCP **response** schema is updated to include `mistakes_in_scope`. Today the MCP server returns `JSON.stringify(pack, null, 2)` with no response schema — fine, but the plan should state that explicitly so no reviewer assumes a Zod response type is missing.

---

## SHOULD FIX

- **[C] `inboxItemIntersectsScope` ignores `scope_aliases`.** Phase 3 section 3.2 checks `scope_mappings` and directory fallback only. The spec's scope derivation order is: explicit → scope_mappings → scope_aliases → directory fallback → feature_hint_mappings → recency. Skipping aliases creates false negatives in renamed-directory scenarios (the exact case `scope_aliases` exists to solve).

- **[C] `MistakeEntry` is a discriminated union but consumers don't enforce exhaustiveness.** Phase 5 renders per-kind branches with an `else` fallthrough in CLI. Add `switch(m.kind) { ... default: const _: never = m; throw new Error(...); }` in the CLI renderer and any future consumer so adding a fourth kind breaks the build rather than silently falling through.

- **[C] "Single construction site" is optimistic.** Phase 1 asserts that `packs.ts:117` is the only `DecisionPack` construction site. This is correct for production code today, but does not account for test fixtures, mock packs, or future snapshot tests that might be added independently. Add a grep check to the Phase 1 validation gate: `grep -rn ": DecisionPack" src/` should show zero matches outside `packs.ts`.

- **[G] Scope intersection too narrow for rejected inbox.** Rejected inbox items often lack standard file scopes (dismissed manual captures, for example, may have sparse `changed_files`). If `changed_files` is empty or points to files outside any mapping, the item is silently dropped. Add a fallback: if `changed_files` is empty, surface via `query` keyword match against `commit_message`.

- **[G] `commit_inferred` exclusion asymmetry.** Excluding `commit_inferred` only from `mistakes_in_scope` but leaving it in `abandoned_approaches` / `recently_superseded` creates a weird invariant: an abandoned commit-inferred decision appears in `abandoned_approaches` but not `mistakes_in_scope`. The spec's "unreviewed inferences never drive autonomous behavior" argues for consistent exclusion — but the user's feature text explicitly limits the exclusion to `mistakes_in_scope`. Document the asymmetry explicitly, or accept it as intentional precedent-preservation (commit_inferred abandoned records are still *context* in `abandoned_approaches`, just not *antipatterns* in `mistakes_in_scope`).

- **[C] MCP annotations must stay `readOnlyHint: true`.** Phase 6 changes the tool description string. The plan does not explicitly call out that annotations must remain unchanged. Make it an explicit subsection of Phase 6.

- **[C] `include_feature_local` gating is not plumbed uniformly.** Phase 3 gates the existing feature-local filter in `query.ts:72–78`, but the same flag is not explicitly applied to the new rejected-inbox classification. Rejected inbox items associated with `feature-local` scopes could leak under `include_feature_local: false`. Add a parallel gate in `inboxItemIntersectsScope` or upstream of it.

---

## DESIGN QUESTIONS

- **[BOTH] Why Option B on trim order?** The literal spec text says Option A. The plan documents Option B as "preserves current active-is-last behavior" but offers no argument for why that should override the literal spec. Needs human input.

- **[BOTH] Is ratifying `rejection_reason` as a typed field acceptable scope for this feature?** It's the right long-term move (eliminates the `as unknown as Record<string, unknown>` cast), but it changes schema and the write path. If accepted, it should appear in the design spec update (Phase 8) as a separate decision.

- **[BOTH] Is the CLI dual-call (`queryDecisions` for mistakes + `searchDecisions` for results) acceptable?** Both reviewers dislike it. Codex: risks mismatched scope/ranking. Gemini: wastes local resources and confuses output. Alternative: replace `searchDecisions` with `queryDecisions` entirely and render the full pack. Needs human input.

- **[G] Tidy TTL vs mistake durability.** Rejected inbox items older than 30 days are deleted by `context-ledger tidy`. Should items with `rejection_reason` survive tidy (mistakes are long-term guardrails) or should the current 30-day tidy window stand?

- **[G] Agent-guard/context-ledger conflict surface.** If agent-guard says "pattern X" and `mistakes_in_scope` says "pattern X caused pain points", agent paralysis is possible. Should retrieval output annotate which source takes precedence?

- **[C] What's the hot-path audit for Phase 9 agent-guard sync?** The spec demands the post-commit hook stays <100ms with zero LLM/network. The plan's Phase 9 says "run `npx agent-guard sync`" — does that touch the post-commit hook? Make it an explicit no-op check (verify `git diff --stat src/capture/` after sync).

- **[G] Naming — `mistakes_in_scope` vs `prior_mistakes` / `known_antipatterns`?** Existing field names follow `adjective_noun` style (`active_precedents`, `abandoned_approaches`, `recently_superseded`). `mistakes_in_scope` uses a `noun_qualifier` pattern not found elsewhere. User explicitly chose this name in the feature request — override for consistency or honor the explicit choice?

---

## SUGGESTED IMPROVEMENTS

- **[C] Add a zero-write contract test.** In Phase 7, add one smoke test that records the pre-query mtime of `ledger.jsonl` and `inbox.jsonl`, runs `queryDecisions(...)` with every code path exercised (including rejected inbox classification), and asserts the files are byte-identical afterward. This makes the "no writes on read path" invariant a test instead of a prayer.

- **[C] Add a response-shape snapshot test.** In Phase 7, snapshot the `query_decisions` response shape with `mistakes_in_scope` populated and an empty variant. Any future type change must update the snapshot, catching silent regressions.

- **[G] Granular `include_feature_local`.** Instead of a boolean flag, accept a specific feature slug so the agent only pulls local mistakes for the sub-feature it's working on. Out of scope for v1; note for future iteration.

- **[G] CLI color coding.** When rendering "Prior mistakes in this scope" in the CLI, apply a distinct color (yellow/red) to differentiate antipatterns from neutral results. The project does not currently use `@clack/prompts` for CLI output (only in setup), so this would need a lightweight ANSI escape wrapper. Optional.

- **[C] Phase 3 helper should mirror full scope derivation.** Make `inboxItemIntersectsScope` call (or share implementation with) `deriveScope` rather than reimplementing a narrower version. Reduces drift risk.

---

## Cross-Checks (run by orchestrator, not the reviewers)

| Check | Result |
|-------|--------|
| Every event type in the guide matches schema in context-ledger-design-v2.md | PASS — no new event types. `MistakeEntry` is a retrieval view, not an event. |
| Every MCP tool matches the spec's parameter list and return format | PARTIAL — `query_decisions` params extended with `include_feature_local` (to be documented in Phase 8). Response shape gains `mistakes_in_scope`. Cross-check confirms no other MCP tool touched. |
| Lifecycle state machine transitions all legal per spec | PASS — this feature writes zero transitions. |
| Auto-promotion threshold >= 0.7 enforced correctly | PASS — `commit_inferred` (0.2) exclusion in `mistakes_in_scope` aligns with the spec's "unreviewed inferences never drive autonomous behavior" rule. |
| Token budgeting implemented on decision packs | PARTIAL — double-counting risk flagged (see CRITICAL). Must resolve before merge. |
| JSONL append-only respected | PARTIAL — Phase 6's typed-spread replacement still writes dismissed items via `rewriteInbox` (pre-existing atomic-rewrite path), which is already the only non-append write. Not a new violation, but schema-change concern stands. |
| `.js` import extensions on all new imports | PASS. |
| MCP annotations unchanged (`readOnlyHint: true, destructiveHint: false, openWorldHint: false`) | PASS — only the description string changes; annotations preserved. |
| Zero new runtime dependencies | PASS. |
| Post-commit hook <100ms, zero LLM/network | PASS — no changes to `src/capture/`. |

**Net assessment:** The plan is architecturally sound but has four CRITICAL issues to resolve before execution: (1) trim-order inversion is wrong as coded, (2) the feature accidentally ratifies a schema change it shouldn't, (3) recency fallback drops a mandated source, (4) token double-counting. Three of four require human input. The rest are Bucket 1 autonomous fixes.
