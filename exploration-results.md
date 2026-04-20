# Exploration Results — v1.2.2 Combined Patch

## Pre-Flight Summary

Three cold-path, schema-neutral changes. (1) Extend `MatchReason` with `"cross_scope_supersede"` and teach `queryDecisions` to surface superseded records whose `replaced_by` target lives in the query scope. One-hop traversal using `state.decisions` Map — the fold already exposes `replaced_by`. (2) Insert a monorepo-root fallback into `deriveScope` between scope_aliases and directory_fallback; new `ScopeSource` value `"monorepo_root"`; returns ids like `packages/foo`. (3) Add three whole-commit seed-rule predicates to `classifyCommit` (gitignore_trivial, ide_config_only, lockfile_only) gated by `config.capture.classifier.seed_rules.*`, each defaulting to `true`. Rule (a) needs a small, conditional `git diff --numstat` call added to the hook; passed into classify via a new optional parameter mirroring `packageJsonDiff`. Zero event-schema changes, zero new dependencies, zero MCP tool changes, zero CLI user-facing changes. Post-commit hook stays under 100ms because the numstat call only runs when `.gitignore` is the only changed file.

## Files to Modify

| File | Issue | Change |
|---|---|---|
| `src/retrieval/packs.ts` | 1 | Extend `MatchReason` union on line 10: add `"cross_scope_supersede"` |
| `src/retrieval/query.ts` | 1 | Insert cross-scope supersede branch in filter loop after line 186, before line 189 |
| `src/retrieval/scope.ts` | 2 | Extend `ScopeSource` union (lines 9–15) with `"monorepo_root"`; insert monorepo-root check between lines 73 and 76 |
| `src/config.ts` | 3 | Add `SeedRulesConfig` interface; extend `ClassifierCaptureConfig` with `seed_rules?: SeedRulesConfig`; add defaults in `DEFAULT_CONFIG.capture.classifier` line 72 |
| `src/capture/classify.ts` | 3 | Add three predicate functions (`isGitignoreTrivialCommit`, `isIdeConfigOnlyCommit`, `isLockfileOnlyCommit`); add early-exit checks after line 222; add new optional `gitignoreDiff` parameter to `classifyCommit` signature |
| `src/capture/hook.ts` | 3 | Add `parseGitignoreDiff` helper mirroring `parsePackageJsonDiff`; call `git diff --numstat` only when `.gitignore` is the only file in `diff.all`; thread result into `classifyCommit` |
| `src/retrieval/smoke-test.ts` | 1, 2 | Add test for cross-scope supersede traversal; add test for monorepo-root fallback |
| `src/capture/classify.test.ts` | 3 | Add three pairs of tests (happy + mixed) — one pair per seed rule |
| `package.json` | all | Bump `"version"` from `1.2.1` to `1.2.2` |
| `CHANGELOG.md` | all | Prepend v1.2.2 entry matching v1.2.1 format |
| `context-ledger-design-v2.md` | all | Bump header from v2.4.1 to v2.4.2; append three decision-table rows between lines 949 and 951 |

**No changes needed** to: `src/ledger/events.ts`, `src/ledger/fold.ts`, `src/mcp/*` tool registrations, `src/cli.ts`, `src/retrieval/index.ts` (re-export picks up union extension), `src/setup.ts` (uses `DEFAULT_CONFIG`).

## Type Changes

### `MatchReason` — `src/retrieval/packs.ts:10`
```ts
export type MatchReason =
  | "scope_hit"
  | "file_path_hit"
  | "tag_match"
  | "broad_fallback"
  | "cross_scope_supersede"; // NEW — v1.2.2
```

### `ScopeSource` — `src/retrieval/scope.ts:9–15`
```ts
export type ScopeSource =
  | "explicit"
  | "config_mapping"
  | "scope_alias"
  | "directory_fallback"
  | "monorepo_root"          // NEW — v1.2.2
  | "feature_hint"
  | "recency_fallback";
```

### `ClassifierCaptureConfig` — `src/config.ts:23–25`
```ts
export interface SeedRulesConfig {
  gitignore_trivial?: boolean;  // default: true
  ide_config_only?: boolean;    // default: true
  lockfile_only?: boolean;      // default: true
}

export interface ClassifierCaptureConfig {
  editor_backup_patterns: string[];
  seed_rules?: SeedRulesConfig; // NEW — v1.2.2
}
```

### `DEFAULT_CONFIG.capture.classifier` — `src/config.ts:72`
```ts
classifier: {
  editor_backup_patterns: ["*.bak", "*.orig", "*.swp", "*.swo", "*~", ".#*", ".DS_Store", "Thumbs.db"],
  seed_rules: {                  // NEW — v1.2.2
    gitignore_trivial: true,
    ide_config_only: true,
    lockfile_only: true,
  },
},
```

### `classifyCommit` signature — `src/capture/classify.ts`
Add new optional parameter at the end (mirrors `packageJsonDiff` pattern):
```ts
export function classifyCommit(
  all: string[],
  deleted: string[],
  added: string[],
  subject: string,
  config: LedgerConfig,
  packageJsonDiff: ParsedPackageJson | null,
  gitignoreDiff?: GitignoreDiff | null,  // NEW — v1.2.2
): ClassifyResult[]
```

Where:
```ts
export interface GitignoreDiff {
  added_lines: number;
  removed_lines: number;
}
```

(No event schema changes — all additive typing.)

## Construction Site Inventory

### For Issue 1 (cross-scope supersede)
- **Match reason assignment**: `src/retrieval/query.ts` filter loop (lines 122–191). Single site. Add new `else if` branch after line 186 (after `tag_match`), before line 189 (`continue`).
- **`recently_superseded` consumer**: `src/retrieval/packs.ts:109–118` already routes superseded records with any `match_reason` into the bucket — no change needed. The new `"cross_scope_supersede"` reason flows through automatically.
- **CLI rendering**: `src/cli.ts:183, 195` prints `match_reason` as a string — new value prints automatically. No switch/enum to update.

### For Issue 2 (monorepo fallback)
- **`deriveScope` callers** — behavior improves automatically for all:
  - `src/retrieval/query.ts:107` — primary query path
  - `src/capture/hook.ts:393` — Tier 2 contradiction detection
  - `src/capture/hook.ts:429` — per-result draft scope enrichment
  - `src/mcp/write-tools.ts:65` — legacy inbox item scope derivation
- **`source` string consumers**: No exhaustive switch anywhere. `src/retrieval/smoke-test.ts` does string equality on `source` at lines 95, 112, 136, 551 — only against existing values. Adding `"monorepo_root"` is safe.

### For Issue 3 (seed rules)
- **`classifyCommit` caller**: `src/capture/hook.ts:373` — single caller. Must be updated to pass new `gitignoreDiff` parameter.
- **Test call sites**: `src/capture/classify.test.ts` (6 existing tests). All call `classifyCommit(...)` with positional args — the new 7th param is optional so existing calls remain type-safe.
- **Config read site**: only `src/capture/classify.ts` itself reads `config.capture.classifier.seed_rules` — no other consumers.

## Recommended Phase Order

Dependencies dictate this order. Each phase is self-contained and independently validatable:

1. **Phase 0 — Preconditions**: Verify git clean, baseline `tsc --noEmit` passes, current version is 1.2.1. Read TODO.md items 5, 6, and 7 for authoritative scope. STOP AND REPORT.

2. **Phase 1 — Issue 2 (smallest, zero ripple)**: Extend `ScopeSource` in `scope.ts`; add monorepo-root fallback logic between scope_aliases and directory_fallback; add test to `src/retrieval/smoke-test.ts`. Validate: `npm run build` passes; new test passes; existing tests unchanged. STOP AND REPORT.

3. **Phase 2 — Issue 1 (adds union member, touches query loop)**: Extend `MatchReason` in `packs.ts`; add cross-scope branch in `query.ts` filter loop; add test to `src/retrieval/smoke-test.ts`. Validate: build passes; new test passes; existing retrieval/smoke-test tests still green. STOP AND REPORT.

4. **Phase 3 — Issue 3 config surface**: Add `SeedRulesConfig` interface; extend `ClassifierCaptureConfig`; add defaults to `DEFAULT_CONFIG`. No behavior change yet. Validate: build passes; deepMerge handles partial user overrides correctly. STOP AND REPORT.

5. **Phase 4 — Issue 3 predicates**: Add three predicate helpers in `classify.ts`; extend `classifyCommit` with optional `gitignoreDiff` parameter; add early-exit checks after line 222. Existing tests must pass unchanged. Validate: build passes; existing `classify.test.ts` still green. STOP AND REPORT.

6. **Phase 5 — Issue 3 hook wiring**: Add `parseGitignoreDiff` helper in `hook.ts`; add conditional `git diff --numstat` call when `.gitignore` is the only changed file; thread result into `classifyCommit` call at line 373. Validate: `hook.test.ts` passes; hook execution budget unchanged. STOP AND REPORT.

7. **Phase 6 — Issue 3 tests**: Add three pairs of tests to `classify.test.ts` — one happy-path (suppression fires) and one mixed-case (suppression does NOT fire) per seed rule. Validate all new tests pass. STOP AND REPORT.

8. **Phase 7 — Docs + version**: Bump `package.json` to 1.2.2; prepend CHANGELOG entry; bump design spec header to v2.4.2; append three decision-table rows. Validate: `npm run build` passes end-to-end; full test suite green. STOP AND REPORT.

9. **Phase 8 — agent-guard sync**: Run `npx agent-guard sync`. STOP AND REPORT.

## Risks and Blockers

### Must-Resolve Before Implementation

1. **Rule (a) needs git numstat but classifyCommit is pure.** The spec says "Use git diff numstat plus a small diff parse to confirm single-line change." The current classifier is a pure function with zero I/O. Resolution: add a conditional second `execFileSync` call in the hook — only invoked when `.gitignore` is the sole file in `diff.all`. Pass result into `classifyCommit` as a new optional param. This preserves purity and keeps the hook under 100ms (the numstat call runs over a single file only when the filename filter already matches).

2. **Monorepo-fallback id format decision.** The feature message offers two options: `{ type: "package", id: "packages/foo" }` or `{ type: "directory", id: "packages/foo" }`. **Recommend**: `{ type: "directory", id: "packages/foo", source: "monorepo_root" }` because (a) it does not claim the directory is a "package" in the event-schema sense (which might not be true for every `packages/*` subdirectory), and (b) it matches the shape of the existing `directory_fallback` branch — only the `source` and `id` format change. Flag this for human confirmation if Gemini/Codex raise it.

3. **`isGitignoreTrivialCommit` happy-path definition.** The spec says "every changed file is .gitignore AND the diff is a single-line add or remove of a pattern." Interpretation: condition is `all.length === 1 && all[0] === ".gitignore" && gitignoreDiff && (gitignoreDiff.added_lines + gitignoreDiff.removed_lines) === 1`. If `gitignoreDiff` is null (hook didn't bother to compute it — e.g. because `all.length > 1`), the rule defaults to NOT suppressing. Document this.

### Non-Blocking but Flag

4. **`test:classify` script may point to a missing file.** pattern-finder notes `package.json` references `src/capture/smoke-test.js` but no such source file appears in the pattern-finder listing; only `classify.test.ts` and `drafter.test.ts` / `hook.test.ts` are confirmed. Verify during Phase 0 — if the script is stale, either fix it OR route new seed-rule tests into `classify.test.ts` (safer, matches existing 6-test pattern). Do NOT fix unrelated test-runner wiring in this patch.

5. **Seed-rule ordering matters.** If a commit changes only `.gitignore` + only a lockfile, both rules (a) and (c) could match. Resolution: evaluate in declared order (gitignore_trivial → ide_config_only → lockfile_only), first match wins, log the first reason. Document in the predicate block.

6. **`.github/` carve-out for rule (b).** Feature spec explicitly excludes `.github/` from IDE-config-only suppression because it can contain meaningful CI workflow changes. Enforce: rule (b) matches `.vscode/`, `.idea/`, `.fleet/`, `.devcontainer/` prefixes only.

7. **Lockfile-without-manifest detection in rule (c).** The rule fires when `all` contains only lockfiles AND the corresponding manifest is absent. Build a lockfile→manifest map: `package-lock.json`/`yarn.lock`/`pnpm-lock.yaml` → `package.json`; `poetry.lock` → `pyproject.toml`; `Cargo.lock` → `Cargo.toml`; `Gemfile.lock` → `Gemfile`; `go.sum` → `go.mod`. Check every lockfile's manifest is absent from the changeset, not just "any manifest".

8. **include_superseded gate on Issue 1.** The cross-scope branch must only fire when `params.include_superseded === true` (or the config default). Otherwise we'd leak superseded records into the filter that would be stripped later by `buildDecisionPack` anyway — wasted work, no functional bug.

### No Ripple Issues Found
- Zero runtime dependencies added (all three fixes use existing Node APIs).
- MCP tool schemas unchanged.
- Event schema unchanged.
- JSONL append-only invariant preserved (none of the three touch ledger writes).
- Auto-promotion threshold logic unchanged.
- `MatchReason` and `ScopeSource` have no exhaustive switches — extending unions is safe.

## Design Spec Compliance

All three issues comply with `context-ledger-design-v2.md`:

- **Event schema** (Issue 1): No new event types, no new fields on `DecisionRecord` or `TransitionEvent`. Cross-scope traversal is derived at query time from existing `replaced_by` and `scope` fields. Matches the spec principle that the ledger is append-only and fold state is derived.
- **Retrieval contract** (Issue 1): `MatchReason` is an open, retrieval-layer concept. The spec's "Decision Pack Response" shape at line ~2400 lists `match_reason` as a string. Adding a new value fits. `recently_superseded` is already a documented bucket.
- **Scope derivation fallback order** (Issue 2): The spec's Scope Derivation Fallback Order (CLAUDE.md quick-ref) is preserved — explicit → scope_mappings → scope_aliases → directory_fallback → feature_hint → recency. Monorepo-root is a refinement of the directory_fallback step, not a reordering. Existing semantics preserved for unrecognized paths.
- **Classifier determinism** (Issue 3): Matches the "Tier 1 / Tier 2 / Ignored" framework. The three new rules are deterministic, config-gated early exits consistent with the existing `ignore_paths`, test-file, and `editor_backup_patterns` filters. No LLM calls, no network.
- **Config shape**: `capture.classifier.seed_rules` nesting is consistent with other nested sub-keys in the config (e.g. `capture.drafter.*`). Additive only; `deepMerge` handles partial user overrides.
- **Version bump**: Patch (1.2.1 → 1.2.2) is correct — all changes are behavior improvements, not breaking.
- **Autonomy axis**: Improves axis #1 (capture quality — Issue 3) and retrieval quality (Issues 1 and 2). Does not unlock new autonomy, does not move the auto-promotion threshold. Matches the v1.2.2 north-star.

**No deviations flagged.** All three fixes stay inside the envelope the spec authorizes.
