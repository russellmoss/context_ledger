# v1.2.1 Exploration Results — Four Dogfood Bug Fixes

Synthesizes `code-inspector-findings.md` and `pattern-finder-findings.md` for the v1.2.1 patch release. Design spec consulted: `context-ledger-design-v2.md` (v2.4 — to be bumped to v2.4.1 as part of this patch).

---

## 1. Pre-Flight Summary

v1.2.1 is four dogfood bug fixes; zero new capabilities, zero new runtime deps, patch-level. All four touch the capture/inbox path; none touch the `ledger.jsonl` event schema. Bug 7 renames the hook drafter's payload key from `proposed_decision` to `proposed_record` with a read-side fallback for legacy items (one writer change + one reader change). Bug 8 populates scope fields in hook-drafted inbox items by calling the existing `deriveScope` helper — its signature is already usable from capture, no refactor needed. Bug 9 adds same-day-revert suppression via a single bounded `git log` shellout in `postCommit`, fail-open under load. Bug 10 filters editor-backup patterns out of the `file-deletion` classifier in `classify.ts`. Config gains `capture.drafter.revert_suppression_window_hours` (default 24) and `capture.classifier.editor_backup_patterns` (default list). Tests extend `src/capture/hook.test.ts` (Tests 7–9) and add `src/capture/classify.test.ts` for Bug 10. Version 1.2.0 → 1.2.1. CHANGELOG + design-spec v2.4 → v2.4.1.

---

## 2. Files to Modify

| File | Change |
|------|--------|
| `src/config.ts` | Add `revert_suppression_window_hours?: number` to `DrafterCaptureConfig` (default 24). Add new `ClassifierCaptureConfig` interface with `editor_backup_patterns: string[]`. Add `classifier` key to `LedgerConfig.capture`. Extend `DEFAULT_CONFIG.capture` with `drafter.revert_suppression_window_hours: 24` and `classifier: { editor_backup_patterns: ["*.bak","*.orig","*.swp","*.swo","*~",".#*"] }`. Export `ClassifierCaptureConfig`. |
| `src/ledger/events.ts` | Extend `ProposedDecisionDraft` (lines 78-86) with optional scope fields: `scope_type?: ScopeType`, `scope_id?: string`, `affected_files?: string[]`, `scope_aliases?: string[]`, `revisit_conditions?: string`, `review_after?: string \| null`. Add `proposed_record?: ProposedDecisionDraft` to `InboxItem` (line 88+) alongside existing `proposed_decision?: ProposedDecisionDraft` (retained as legacy read-only alias). |
| `src/capture/hook.ts` | (a) `buildInboxItem` (lines 36-61): write `item.proposed_record = proposedDecision` instead of `item.proposed_decision`. Populate scope fields on `proposedDecision` before passing in — compute scope in the drafting loop (line 372 already has `derived`) and thread it into `buildInboxItem`. (b) Add `isRevertSuppressed(projectRoot, sha, fullBody, config)` helper + call after merge-commit check (~line 267) before classification (line 299). If suppressed, log and return. |
| `src/capture/classify.ts` | Add `DEFAULT_BACKUP_PATTERNS` module constant and `isEditorBackup(p, patterns)` helper (hand-rolled glob: escape `.`, map `*` to `[^/]*`, test against filename segment only). Extend `unclaimed` filter at line 314 to drop editor-backup deletions. Pass `config` (already a param of `classifyCommit`) for pattern list. |
| `src/mcp/write-tools.ts` | `confirm_pending` line 186: change `const proposed = item.proposed_record;` to `const proposed = item.proposed_record ?? (item as unknown as { proposed_decision?: ProposedRecord }).proposed_decision;`. Default missing scope_type/scope_id/affected_files/scope_aliases/revisit_conditions/review_after at `DecisionRecord` construction lines 196-210 for legacy items that lack them. |
| `src/capture/hook.test.ts` | Rename 9 assertions from `proposed_decision` to `proposed_record` (lines 160, 161, 163, 165, 166, 167, 170, 171, 207, 208 per code-inspector). Add Test 7 (revert-within-window suppresses both sides), Test 8 (revert-outside-window both draft normally), Test 9 (hook-drafted inbox items carry scope_type/scope_id/affected_files). |
| `src/capture/classify.test.ts` *(NEW)* | Bug 10 tests: backup-only deletions (foo.bak + bar.orig, no other changes) return no file-deletion classification; mixed deletions (foo.bak + src/real.ts) classify with only src/real.ts in changed_files; .gitignore + backup deletions suppress entirely. Follow the fixture pattern from existing hook.test.ts helpers. |
| `src/smoke.ts` | Optional end-to-end test (`test7_hookDrafterScopeAndKey`) asserting `proposed_record` key presence + scope population on a hook-drafted item. Follow the `testN_name` numbering. |
| `CHANGELOG.md` | New v1.2.1 entry at top. Four bullet groups matching existing style (capture/classify/config/spec). Date: 2026-04-20 (or release day). |
| `context-ledger-design-v2.md` | Bump v2.4 → v2.4.1. Add decision-table entries for the four bug fixes with `Source` column = `"dogfood 2026-04-19"`. Rows 1 and 2 (payload-key unification, scope-field population) are substantive standalone entries; rows 3 and 4 (revert suppression, editor-backup suppression) may be one combined classifier-hygiene entry. |
| `package.json` | 1.2.0 → 1.2.1 via `npm version patch` at release time (NOT during implementation). |

**Barrel exports:** `src/ledger/index.ts:18` already re-exports `ProposedDecisionDraft` — extended fields propagate automatically. `src/retrieval/index.ts` and `src/capture/index.ts` need no changes (deriveScope signature unchanged; ClassifierCaptureConfig stays in config.ts). `src/retrieval/packs.ts` and `src/cli.ts` do NOT read the draft payload today — no unification reads to add there despite the feature-request wording.

---

## 3. Type Changes — exact deltas

### `src/config.ts`

```ts
export interface DrafterCaptureConfig {
  enabled: boolean;
  model?: string;
  timeout_ms?: number;
  max_diff_chars?: number;
  revert_suppression_window_hours?: number;  // NEW — default 24
}

// NEW — export alongside DrafterCaptureConfig
export interface ClassifierCaptureConfig {
  editor_backup_patterns: string[];
}

// LedgerConfig.capture gains:
//   classifier: ClassifierCaptureConfig;

// DEFAULT_CONFIG.capture gains:
//   drafter: { enabled: true, revert_suppression_window_hours: 24 },
//   classifier: { editor_backup_patterns: ["*.bak","*.orig","*.swp","*.swo","*~",".#*"] },
```

### `src/ledger/events.ts`

```ts
// Extend ProposedDecisionDraft (currently lines 78-86) — all OPTIONAL:
//   scope_type?: ScopeType;
//   scope_id?: string;
//   affected_files?: string[];
//   scope_aliases?: string[];
//   revisit_conditions?: string;
//   review_after?: string | null;

// InboxItem: add NEW field alongside existing —
//   proposed_record?: ProposedDecisionDraft;   // NEW canonical
//   proposed_decision?: ProposedDecisionDraft; // LEGACY — read-only alias, not written
```

### `src/mcp/write-tools.ts` — no type changes

Local `ProposedRecord` (lines 31-48) stays structurally a superset of the extended `ProposedDecisionDraft`. `PersistedInboxItem.proposed_record: ProposedRecord` narrows the optional base type — legal in TypeScript. The write path at line 130 already emits `proposed_record`; only the read path at line 186 gains a legacy fallback.

---

## 4. Construction Site Inventory

### Writers of the draft payload (all emit `proposed_record` after v1.2.1)

| Site | File:Line | Change |
|------|-----------|--------|
| Hook drafter | `src/capture/hook.ts:59` (`buildInboxItem`) | Rename field, populate scope_type/scope_id/affected_files/scope_aliases via `deriveScope` result. |
| MCP `propose_decision` | `src/mcp/write-tools.ts:130` | Already emits `proposed_record` with full scope fields. No change. |

### Readers of the draft payload (fall back to `proposed_decision` for legacy items)

| Site | File:Line | Change |
|------|-----------|--------|
| `confirm_pending` | `src/mcp/write-tools.ts:186` | Add `?? item.proposed_decision` fallback; default missing scope fields. |
| `src/retrieval/packs.ts` `pending_inbox_items` (~line 205) | Passes whole InboxItem through; does not read draft payload today. | No change. |
| `src/cli.ts handleQuery` lines 210-216 | Reads envelope fields only; does not render draft payload. | No change. |
| `src/mcp/read-tools.ts` query_decisions orchestrator | Does not read draft payload. | No change. |
| `src/mcp/smoke-test.ts:120` | Already casts to `proposed_record`. | No change. |
| `src/capture/hook.test.ts` | 9 assertions at 160-171, 207-208 on `proposed_decision`. | Rename to `proposed_record`. |

### Revert-check insertion site

`src/capture/hook.ts` between merge-commit check (~line 267) and classification (line 299). `sha` already resolved at line 253; `fullBody` at line 255. New helper shells out `git log -n 20 --format=%H%x00%s%x00%b%x00%ct` with `{ cwd: projectRoot, encoding: "utf8", stdio: "pipe" }`, wrapped in try/catch, fail-open. Returns `true` if:
1. Any recent commit's subject starts with `Revert ` AND its body contains `This reverts commit <current-sha>` AND that commit's `ct` (commit time) is within window; OR
2. `fullBody` of current commit starts with `Revert ` AND contains `This reverts commit <sha>` AND that target commit's `ct` is within window (parsed from same git-log output, with sha match).

### File-deletion classifier insertion site

`src/capture/classify.ts:314`:

```ts
// BEFORE
const unclaimed = del.filter((f) => !claimedFiles.has(f) && !isTestFile(f) && !isDocFile(f));

// AFTER
const backupPatterns =
  config.capture.classifier?.editor_backup_patterns ?? DEFAULT_BACKUP_PATTERNS;
const unclaimed = del.filter(
  (f) => !claimedFiles.has(f) && !isTestFile(f) && !isDocFile(f) && !isEditorBackup(f, backupPatterns),
);
```

`DEFAULT_BACKUP_PATTERNS` is a module-level fallback so unit tests can pass a minimal config. `isEditorBackup` matches against `path.split("/").pop()` (filename segment only).

### deriveScope callers audit (all must keep working)

| Caller | File:Line | Status after patch |
|--------|-----------|-------------------|
| Tier-2 contradiction check | `src/capture/hook.ts:318` | Unchanged. |
| Drafter precedent lookup | `src/capture/hook.ts:372-374` | Unchanged; Bug 8 reuses this result. |
| Query orchestrator | `src/retrieval/query.ts:107-111` | Unchanged. |

**Signature change:** none required. Three-parameter signature `(params, config, decisions)` is already callable from capture-side.

---

## 5. Recommended Phase Order

Nine phases. Each has a bash/grep validation gate and a STOP AND REPORT checkpoint.

**Phase 1 — Blocking Prerequisites.** Working tree clean; `npm run build` green on current master before any edit. Gate: `git status --porcelain` returns no lines; `npm run build` exits 0.

**Phase 2 — Type Definitions (intentionally breaks the build).** Edit `src/config.ts` (`DrafterCaptureConfig` field, `ClassifierCaptureConfig`, LedgerConfig.capture, DEFAULT_CONFIG) and `src/ledger/events.ts` (extend `ProposedDecisionDraft`, add `InboxItem.proposed_record`). Gate: `npx tsc --noEmit 2>&1 > /tmp/phase2.log`; count errors; verify the error set is exactly {`src/capture/hook.ts` (field rename), `src/mcp/write-tools.ts` (reader fallback), test files}. Any other file erroring is a red flag.

**Phase 3 — Classifier (Bug 10).** `src/capture/classify.ts`: add `DEFAULT_BACKUP_PATTERNS`, `isEditorBackup` helper, extend `unclaimed` filter. Gate: `npx tsc --noEmit` shows classify.ts clean.

**Phase 4 — Hook drafter payload rename + scope population (Bugs 7 + 8).** `src/capture/hook.ts`: update `buildInboxItem` signature to accept a `DerivedScope | null`, rename to `proposed_record`, populate scope fields. Thread `derived` from line 372 into the `buildInboxItem` call at line 400. Gate: `grep -n "proposed_decision" src/capture/hook.ts` returns zero write sites (only type imports / legacy-read comments acceptable).

**Phase 5 — Revert suppression (Bug 9).** Add `isRevertSuppressed` helper and call site after line 267. Use `execSync` with `stdio: "pipe"`, try/catch, fail open. Gate: `grep -n "isRevertSuppressed\|Revert " src/capture/hook.ts` shows the helper; hook.test.ts still type-checks.

**Phase 6 — Read-side fallback (Bug 7 legacy).** `src/mcp/write-tools.ts:186`: add `?? item.proposed_decision` fallback; default missing scope_type/scope_id/affected_files/scope_aliases/revisit_conditions/review_after in DecisionRecord construction (lines 196-210). Gate: `npx tsc --noEmit` clean for write-tools.ts; `grep -n "proposed_decision" src/mcp/write-tools.ts` = exactly one fallback read site.

**Phase 7 — Tests.** Update `src/capture/hook.test.ts` (9 assertion renames + Tests 7, 8, 9). Add `src/capture/classify.test.ts` (Bug 10 tests). Optional: `src/smoke.ts` end-to-end test. Gate: `npm run build` clean; `node dist/capture/hook.test.js`, `node dist/capture/classify.test.js`, `node dist/capture/drafter.test.js` all exit 0; `node dist/smoke.js` and `node dist/retrieval/smoke-test.js` and `node dist/mcp/smoke-test.js` all pass.

**Phase 8 — Documentation Sync.** Run `npx agent-guard sync`. Update `context-ledger-design-v2.md` v2.4 → v2.4.1 with four decision-table entries (Source: "dogfood 2026-04-19"). Add v1.2.1 CHANGELOG entry. Do NOT bump `package.json` version. Gate: `git diff --stat docs/_generated/` shows only expected regenerations; spec version-line updated; CHANGELOG has new top entry.

**Phase 9 — Final Validation + Manual Smoke.** `npm run build` (zero errors). All auto tests pass. Manual hook smoke: seed temp repo, make a feat commit that triggers drafter (requires ANTHROPIC_API_KEY or a mock), confirm `proposed_record` key + scope fields present; make an immediate revert, confirm zero new inbox items. Clean temp repo. Gate: all automated tests green + manual smoke confirms Bugs 7/8/9/10 all fixed end-to-end.

---

## 6. Risks and Blockers

| # | Risk | Mitigation |
|---|------|-----------|
| R1 | `ProposedRecord` (write-tools local) has more fields than the extended `ProposedDecisionDraft` (`evidence_type`, `source`, `commit_sha`). Is `PersistedInboxItem.proposed_record: ProposedRecord` a legal narrowing of `InboxItem.proposed_record?: ProposedDecisionDraft`? | Yes — `ProposedRecord`'s fields are a structural superset of the extended `ProposedDecisionDraft`. TypeScript allows narrowing optional types in extending interfaces. Verify via `tsc --noEmit` in Phase 2. |
| R2 | Hook path must stay <100ms. Adding a `git log` shellout for revert check eats into budget. | Use existing `execSync` pattern (no new spawn overhead). Single call, `-n 20`, minimal format. Wrap in try/catch, fail open on any error. No timeout option set — consistent with other shellouts in the hook. Typical local repo: git log -n 20 runs <10ms. |
| R3 | `git log --format=%H%x00%s -n 20` may not include the reverted-commit reference (which is in the BODY, not the subject, for `git revert`-generated commits). | Use `--format=%H%x00%s%x00%b%x00%ct` (body + commit-time included). Scan body for `This reverts commit <sha>` regex. Parse `ct` to compare against window. Cost stays small. |
| R4 | Legacy inbox items with only `proposed_decision` and missing scope_type/scope_id/affected_files/scope_aliases — `confirm_pending` would construct a DecisionRecord with empty strings, which may fail validation. | Default missing `scope_type` to `"directory"`, `scope_id` to marker `"unknown"`, `affected_files` to `item.changed_files`, `scope_aliases` to `[]`, `revisit_conditions` to `""`, `review_after` to `null`. These are the v1.1.0 pre-Bug-8 expected-if-populated values — correct for legacy items. |
| R5 | `editor_backup_patterns` uses shell-glob syntax. Zero runtime deps means hand-rolled matching. | Match against filename segment only (`path.split("/").pop()`). Compile each pattern to regex: escape `.`, replace `*` with `[^/]*`. Patterns without wildcards match-exact. Implementation: ~20 lines, testable in isolation. |
| R6 | Spec mentions "commit touches .gitignore AND .gitignore diff adds one of those patterns" — an extra suppression sub-rule. | Simpler correct behavior: filter backups out of `unclaimed`. If all deletions are editor-backups, suppress regardless of .gitignore changes. The .gitignore-adds-pattern condition is additive context, not a gate. Skip the sub-rule unless a test demands it. |
| R7 | New config `classifier` key under `capture` — users with older config.json rely on deep-merge. | Code-inspector verified `src/config.ts:107-122` deepMerge recurses plain objects, replaces arrays. Adding a new sub-object is safe. Empty user `capture` config still gets full defaults. |
| R8 | `src/retrieval/packs.ts` listed in feature request as a consumer to unify. | It does not read the draft payload today — passes InboxItem transparently. No code change needed. Call this out in the guide so reviewers don't look for a missing edit. |
| R9 | `buildInboxItem` in hook.ts currently takes 6 params. Adding `derivedScope` makes 7. | Option A: add `derivedScope: DerivedScope \| null` as param 7. Option B: accept pre-populated `ProposedDecisionDraft` with scope fields already set. Option A is simpler and keeps the drafter's `synthesizeDraft` output untouched (that function doesn't produce scope fields). Prefer Option A. |
| R10 | `classifyCommit` already takes `config: LedgerConfig`. Bug 10 just reads `config.capture.classifier?.editor_backup_patterns`. No signature change. | Confirmed. |

No hard blockers. No spec ambiguity that requires human input. All four fixes are orthogonal and implementable in a single session.

---

## 7. Design Spec Compliance

All four fixes are additive at the user-visible API level and preserve every v2.4 invariant:

- **JSONL append-only:** No existing lines in `ledger.jsonl` or `inbox.jsonl` rewritten. `rewriteInbox` untouched. All new paths are append-only or read-only.
- **Post-commit hook <100ms, zero LLM, zero network:** Revert check adds one bounded `git log` shellout; fail-open on slowness. Classifier changes are in-memory only. Drafter scope population reuses an in-scope `deriveScope` call — zero additional I/O.
- **No `ledger.jsonl` event schema changes:** `DecisionRecord` and `TransitionEvent` untouched. Only `InboxItem` (workflow queue, not event log) and the embedded `ProposedDecisionDraft` shape change — direct precedent with v1.2.0's `rejection_reason` ratification.
- **MCP tool annotations unchanged:** No new tools, no new tool parameters, no annotation flips. `propose_decision`/`confirm_pending` external signatures stay byte-identical.
- **Zero new runtime deps:** All four fixes use Node stdlib (`child_process.execSync`) and existing project modules (`deriveScope`, `loadConfig`).
- **`commit_inferred` exclusion (weight 0.2):** Unchanged. Fixes touch capture/classify, not retrieval weighting.
- **Feature-local durability default exclusion:** Unchanged.
- **Auto-promotion threshold (≥0.7 + precedent + active + scope overlap + articulable rationale):** Unchanged.
- **Lifecycle state machine (superseded terminal, no cycles):** Unchanged.

**Spec deviations:** None. The feature request mentions updating `src/retrieval/packs.ts` as a reader of the draft payload — code-inspector confirms packs.ts does not read the payload today. Guide must call this out so reviewers don't expect a non-existent edit.

**Version bump:** Patch (1.2.0 → 1.2.1) correct per SemVer — additive, backward-compatible, preserves response shapes. No user-visible API breakage.

**Design-spec update:** v2.4 → v2.4.1 with four decision-table rows sourced "dogfood 2026-04-19". Rows 1–2 (payload-key unification, scope-field population) are substantive; rows 3–4 (revert suppression, editor-backup suppression) can combine into one classifier-hygiene entry. No structural section changes.
