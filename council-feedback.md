# Council Feedback — v1.2.2 Combined Patch

Consolidated review from **Codex** (gpt-5.4, engineering lens) and **Gemini** (gemini-3.1-pro-preview, DX/spec lens). Merged, deduplicated, and cross-checked against the current source tree.

---

## CRITICAL — Must Fix Before Execution

### C1. `.gitignore` subdirectory mismatch between hook gate and classifier predicate
**Both reviewers flagged.** The hook gate in Phase 5 reads:
```ts
diff.all.length === 1 && diff.all[0].toLowerCase() === ".gitignore"
```
That matches ONLY a repo-root `.gitignore`. But `isGitignoreTrivialCommit()` in Phase 4 matches any path whose basename is `.gitignore` (after normLower + split). A commit touching `packages/foo/.gitignore` will therefore:
- Satisfy the classifier's `gitignoreOnly` check, BUT
- Never receive a `gitignoreDiff` (hook skipped the numstat).

Result: the rule fails open silently on any subdirectory `.gitignore`. Two layers disagree.

**Fix:** align on "any `.gitignore` in the tree, sole file". Introduce a helper `isSoleGitignore(paths)` in the hook that returns the path itself when `paths.length === 1 && basename(paths[0]).toLowerCase() === ".gitignore"`, else null. Pass the actual path to `git diff --numstat HEAD~1 HEAD -- <path>`.

### C2. `inboxItemIntersectsScope` in query.ts has a separate path-derivation copy-paste
**Codex flagged.** `src/retrieval/query.ts` has a `inboxItemIntersectsScope` helper (lines 32–80 per Codex) that implements its own directory-derivation logic, NOT calling `deriveScope`. After Phase 1, `deriveScope("packages/foo/src/bar.ts")` returns `{ id: "packages/foo", source: "monorepo_root" }`, but `inboxItemIntersectsScope` will still compute something else — likely the old basename. Result: `mistakes_in_scope` and dismissed-inbox entries for monorepo-root queries silently drop.

**Verify:** read `src/retrieval/query.ts` lines 32–80 during Phase 0 to confirm. If confirmed, factor out a shared `deriveScopeFromPath()` helper in `scope.ts` and call it from both sites — OR duplicate the monorepo-root check inline in `inboxItemIntersectsScope`.

### C3. `include_superseded` split-brain between query filter and pack builder
**Codex flagged.** The new cross-scope branch gates on `params.include_superseded ?? config.retrieval.include_superseded` (handling the config default). But `buildDecisionPack` at `src/retrieval/packs.ts:109` currently gates `recently_superseded` emission on `params.include_superseded` ALONE (no config fallback). If the caller omits the param and config has `retrieval.include_superseded = true`:
- Query's filter keeps the superseded record (with cross-scope match reason),
- Pack builder drops it from `recently_superseded`.

Silent wrong output for exactly the users who set the config default.

**Fix:** compute `const includeSuperseded = params.include_superseded ?? config.retrieval.include_superseded;` once in `queryDecisions`, and pass it into `buildDecisionPack` (new param or mutate params object). Query filter and pack builder must see the same effective value.

### C4. `lockfile_only` is path-insensitive; monorepo pairing breaks the rule
**Codex flagged.** The proposed `isLockfileOnlyCommit()` builds `requiredManifests` as a set of BASENAMES and checks `requiredManifests.has(parts[parts.length - 1])` across the entire changeset. Breaks in this case:

- Commit changes `packages/a/package-lock.json` (intent: bump lockfile for package a only — no manifest change for a).
- Same commit ALSO changes `packages/b/package.json` (unrelated dep work in sibling package b — b's commit is a Tier 1 dependency-addition).
- Basename-only check sees `package.json` in the changeset → rule does NOT suppress → Correct, classifier runs on `packages/b` side.

BUT: the mixed commit is now being treated as a dependency change for package a too. The ideal semantics would be "for each lockfile, check whether the MATCHING-DIRECTORY manifest is present."

**Fix:** compare `(parentDir, basename)` tuples. Lockfile `packages/a/package-lock.json` requires manifest `packages/a/package.json`. If not present, suppress THIS lockfile's contribution. Otherwise classify normally. However, since `isLockfileOnlyCommit` is whole-commit, the cleanest correction is:
- Require every lockfile to have its matching-dir manifest ABSENT from the changeset.
- If any lockfile has its matching manifest present, do NOT suppress (leave classification to the existing dependency-addition detector).

### C5. `HEAD~1` fails on initial commits
**Gemini flagged.** `git diff --numstat HEAD~1 HEAD -- .gitignore` fails at repo-root-commit time because HEAD~1 doesn't exist. The proposed try/catch returns `null` (fail-open, no suppression — correct behavior), but the failing git invocation dumps a `fatal:` line to stderr, conflicting with the diagnostic channel contract.

**Fix:** guard with `git rev-parse --verify HEAD~1 2>/dev/null` (or equivalent) before calling diff. If the verify fails, return `null` silently. Keep fail-open semantics.

### C6. `test:classify` script may not run the new tests
**Gemini flagged, also exploration Risk #4.** If `package.json`'s `test:classify` script references `src/capture/smoke-test.js` or any path that isn't the compiled `classify.test.js`, the new 6 tests never execute. Phase 0 must verify, and Phase 6 must fix the npm script path if it's stale (or add a second script `test:classify:unit` — TBD during triage).

---

## SHOULD FIX — Before Merge

### S1. `MatchReason` naming — "cross_scope_supersede" vs "replacement_scope_hit"
**Gemini flagged.** Existing members (`scope_hit`, `file_path_hit`, `tag_match`, `broad_fallback`) describe HOW the match happened. `cross_scope_supersede` describes WHAT the record is. A more ontologically consistent alternative: `replacement_scope_hit`.

Bucket: **human input**. Once chosen, both guide + test assertions must use the chosen name.

### S2. Dangling-pointer guard comment
**Gemini flagged.** The guide's branch already guards `if (replacement && ...)` — not a bug — but add an explanatory comment: `// replacement may be missing if ledger was trimmed/corrupted — treat as no-match, continue`.

### S3. Scope-derivation order narrative doc update
**Gemini flagged.** Phase 7 adds a decision-table row for monorepo_root but does not update the narrative prose that lists the fallback order. The authoritative list should read: `explicit → config_mapping → scope_aliases → monorepo_root → directory_fallback → feature_hint → recency`.

**Fix:** extend Phase 7 to update the narrative text in `context-ledger-design-v2.md` (search for the existing order list) AND flag for agent-guard sync in Phase 9 — if the doc is regenerated, the update may be overwritten.

### S4. Windows path normalization on `ide_config_only`
**Gemini flagged.** Rule (b)'s predicate uses `normLower(f).startsWith(".vscode/")`. `normLower` already replaces backslashes (confirmed at `classify.ts:24`). Safe — but add a Windows-path regression assertion to test 9.

### S5. `parseGitignoreDiff` numstat edge cases
**Codex flagged.** numstat can emit `-` for non-text diffs. The guide's `parseInt('-')` returns `NaN`, caught by `Number.isFinite` check → returns `null`. Correct. Add comment documenting expected `-` behavior on binary files (rare for `.gitignore` but possible for gitignore.pack or exotic cases).

### S6. test 12 — confirm `change_category === "dependency-addition"`
**Codex flagged.** Codex confirms this string is emitted by the existing dependency-addition detector. Also: only `package.json` lands in `changed_files`, NOT `package-lock.json`. Guide should document that expectation in the test comment. No functional change.

### S7. Explicit comment on cross-scope branch placement
**Codex flagged.** The branch must stay inside the `else { derivedScope !== null }` block. Add a comment: `// derivedScope is guaranteed non-null here (outer else branch)`. Prevents a future refactor from hoisting it.

### S8. Classifier test positional arg discipline
**Codex flagged.** New tests must pass `classifyCommit(all, del, add, msg, config, pkgDiff, gitignoreDiff)` with all 7 positions explicit (passing `null` for unused). Keeps tests robust if more optional params land later. Current Phase 6 is consistent; just be explicit in the narrative.

---

## DESIGN QUESTIONS — Need Human Input

### D1. Should cross-scope supersede surface WITHOUT `include_superseded=true`?
**Gemini flagged.** The primary dogfood bug (`d_1776622785_4bba → d_1776623004_155f`) was discovered when querying `packages/analyst-bot`. With `include_superseded` defaulting to false and the new branch gated on it, the dogfood case STILL won't surface by default. Fix may not fix the reported pain.

Options:
- **(A) Keep the gate.** Users opt in. Conservative, matches spec default.
- **(B) Surface cross-scope supersede entries regardless of include_superseded.** They're by definition relevant to the current scope (their replacement lives there), so they're not "stale irrelevant history" — they're "part of this scope's genealogy."

**Recommend (B).** But needs human confirmation — it is a defaults change.

### D2. One-hop vs multi-hop supersede chain
**Gemini flagged.** Feature spec says one hop. If A superseded by B superseded by C, querying C misses A.

Options:
- **(A) Keep one hop** (spec as written). Simplest; misses deep history.
- **(B) Walk up to N hops.** Surfaces abandoned lineage.

**Recommend (A)** — match spec. If future dogfooding shows missing deep history, v1.3.0 revisits.

### D3. Scope id format — `packages/foo` vs `foo`
**Both flagged, also exploration Risk #2.**

Options:
- **(A) `{ id: "packages/foo" }`** — namespaced, prevents `packages/foo` vs `apps/foo` collisions. Slash in id.
- **(B) `{ id: "foo" }`** — basename only. Cleaner but loses namespace.

**Recommend (A)** — explicit namespacing.

### D4. `monorepo-root` consult `config.monorepo.package_name`?
**Codex flagged.** Existing config field unused.

**Recommend: leave unused.** Hardcode `packages/`, `apps/`, `services/`. If users want explicit control, they add `scope_mappings`. Revisit if need arises.

### D5. `cross_scope_supersede` check replacement's active state?
**Codex flagged.** Current: replacement found with matching scope → match. Does NOT require replacement's state to be `active`.

**Recommend: no state check.** A's relation to B's scope doesn't erase if B is itself later superseded. Needs human confirmation.

### D6. `gitignore_trivial` — root-only vs any-tree?
**Both flagged, tied to C1.**

**Recommend: any-tree.** Monorepos commonly have per-package `.gitignore`. Aligns C1's fix. Needs human confirmation.

---

## SUGGESTED IMPROVEMENTS — Not Blocking

### I1. Generic `fileStats` parameter instead of specific `GitignoreDiff`
**Gemini.** Forward-compat for more seed rules. Over-engineering for current scope. **Not applying** — log as v1.3.0.

### I2. Factor `deriveScopeFromPath()` helper
**Codex.** Already folded into C2's fix.

### I3. Unit test for deepMerge boolean override
**Gemini.** Low-cost, high-value regression guard. **Applying** — add to Phase 3 or Phase 6.

### I4. LLM tool-description hint about `replaced_by`
**Gemini.** MCP tool annotations unchanged this release (invariant). **Not applying** — v1.3.0 DX polish.

### I5. Config-default include_superseded smoke test
**Codex.** Folded into C3's fix.

### I6. Lockfile dir-pair tuple comparison
**Codex.** Folded into C4's fix.

---

## CROSS-CHECKS AGAINST SPEC

- Event schemas: unchanged. No new event types, no new fields on `DecisionRecord` / `TransitionEvent`.
- MCP tool contracts: unchanged. No param changes, no annotation changes.
- Lifecycle state machine: no transitions introduced, no changes to legal transitions.
- Auto-promotion threshold (≥ 0.7, precedent, active): unchanged and enforced as before.
- Token budgeting on decision packs: unchanged from v2.4.1.
- JSONL append-only invariant: preserved (none of the three fixes write to the ledger).
- Zero runtime dependencies: confirmed.

All fixes stay inside the spec envelope.

---

## TRIAGE SUMMARY (for Phase 4)

| Item | Bucket |
|---|---|
| C1 — .gitignore subdirectory | Apply autonomously (after resolving D6) |
| C2 — inboxItemIntersectsScope | **VERIFY** source, then apply autonomously |
| C3 — include_superseded split-brain | Apply autonomously |
| C4 — lockfile_only dir-pair | Apply autonomously |
| C5 — HEAD~1 guard | Apply autonomously |
| C6 — test:classify script path | **VERIFY** Phase 0, apply in Phase 6 if needed |
| S1 — MatchReason name | **Human input** |
| S2 — dangling-pointer comment | Apply autonomously |
| S3 — scope order narrative doc | Apply autonomously |
| S4 — Windows path test | Apply autonomously |
| S5 — numstat edge comment | Apply autonomously |
| S6 — test 12 narrative | Apply autonomously |
| S7 — cross-scope placement comment | Apply autonomously |
| S8 — positional arg discipline | Apply autonomously |
| D1 — cross-scope default surface | **Human input** |
| D2 — one-hop vs multi-hop | Apply recommendation (A) — one hop |
| D3 — scope id format | Apply recommendation (A) — `packages/foo` |
| D4 — consult config.monorepo | Apply recommendation (A) — no |
| D5 — replacement state check | Apply recommendation (A) — no state check |
| D6 — gitignore root vs any-tree | **Human input** (ties to C1) |
| I1 — generic fileStats | Note, don't apply |
| I3 — deepMerge test | Apply autonomously |

**Human gate questions** (to surface after Bucket 1 applied): S1, D1, D6.
