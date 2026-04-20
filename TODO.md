# TODO

Post-publish follow-ups deferred from the v1.2.0 release (`mistakes_in_scope`). None block a release; all cause friction within a few releases if ignored.

## 1. Add a LICENSE file

`package.json` declares `"license": "ISC"` but no `LICENSE` file exists in the repo. The npm tarball ships with no license text. Add a top-level `LICENSE` file with the ISC license body and commit in a standalone chore commit.

## 2. Add `.gitattributes` to pin line endings

No `.gitattributes` exists. On Windows, `git diff` emits "LF will be replaced by CRLF" warnings for every modified text file; cross-platform collaborators will see line-ending churn. Add:

```
* text=auto eol=lf
```

Commit in a standalone chore commit. Consider running `git add --renormalize .` afterward so existing files are normalized in one commit.

## 3. Exclude test files and source maps from the npm tarball

`npm publish --dry-run` for v1.2.0 showed ~160 kB of test code shipping to end users (`dist/*/smoke-test.js`, `dist/capture/drafter.test.js`, `dist/capture/hook.test.js`, `dist/ledger/dogfood.js`, `dist/smoke.js`, `dist/smoke-drafter.js`, plus their `.js.map` and `.d.ts` files). Source maps dominate the unpacked size (541 kB total). Pre-existing — was already shipping in v1.1.0.

Options, least invasive first:
- Add a `.npmignore` covering `dist/**/smoke-test.*`, `dist/**/*.test.*`, `dist/smoke.*`, `dist/smoke-drafter.*`, `dist/ledger/dogfood.*`. Source maps stay.
- Add a `tsconfig.build.json` with `"exclude": ["src/**/smoke-test.ts", "src/**/*.test.ts", "src/smoke.ts", "src/smoke-drafter.ts", "src/ledger/dogfood.ts"]` and point `prepublishOnly` at it. Test files are not emitted to `dist/` at all.
- Turn off `"sourceMap"` in `tsconfig.json` for the publish build if debuggability isn't worth the weight.

The second option is cleanest but requires threading both tsconfigs through the `build` and `prepublishOnly` scripts.

## 4. Fix `src/ledger/dogfood.js` to write to a tempdir

`npm run test:dogfood` writes to the real project `.context-ledger/ledger.jsonl` instead of an isolated tempdir. Running dogfood during the v1.2.0 audit appended a duplicate decision entry (`d_1776619826_2d69`, "Event fold uses log order not timestamp order") that had to be reverted before commit. All other smoke tests correctly use `mkdtemp`; dogfood is the outlier.

Fix: mirror the `mkdtemp(join(tmpdir(), "cl-dogfood-"))` pattern used in `src/retrieval/smoke-test.ts` and `src/smoke.ts`. Clean up with `rm(dir, { recursive: true, force: true })` in a `finally`. No other changes needed — the test's assertions don't depend on the ledger path.

## 5. v1.2.2 retrieval-tuning — transition-aware scope traversal

When a supersede transition's `replaced_by` lands in scope S, the superseded record should surface in S's `recently_superseded` array even if the superseded record's own scope is narrower or different. Today, a package-scoped query does not surface supersede history for decisions originally scoped to concerns within that package. Discovered via dogfood verification on 2026-04-19 chasing `d_1776622785_4bba` (concern/analyst-bot-planning) → `d_1776623004_155f` (package/packages/analyst-bot).

## 6. v1.2.2 retrieval-tuning — scope derivation fallback for fully-qualified file paths

Scope derivation falls back to filename when given a fully-qualified file path that doesn't match an explicit `scope_mapping`. Observed: file_path `"packages/analyst-bot/src/report-generator.ts"` derived scope `"directory/report-generator.ts"` via `directory_fallback`, not `"directory/packages/analyst-bot"` or `"package/packages/analyst-bot"`. The retrieval still matched via `file_path_hit` against the record's `affected_files`, so this is a cosmetic/diagnostic issue rather than a correctness bug — but the `derived_scope` being reported is misleading. Consider: deriving scope from the deepest matching `scope_mapping` prefix, or from the top-level dir under `src/` / `packages/`. Discovered 2026-04-19.

## Next feature priority (post-v1.2.2 hygiene)

**Transcript miner** — cold-path capture source that reads Claude Code (`~/.claude/projects/<hash>/*.jsonl`) and Codex local transcripts, segments by session, and emits `draft_needed` inbox items with richer proposed drafts than diff-only classification can produce. Autonomy axis #2. Zero hot-path impact, opt-in, redaction mandatory. See `/auto-feature` prompt in prior session history.

## 7. v1.2.2 — Classifier seed rules (extend editor-backup pattern)

Ship additional hard-coded suppression rules in src/capture/classify.ts following the same pattern v1.2.1 established for editor_backup_patterns. Seed rules fire at N=0 for every user — no data accumulation required. Candidate set: (a) trivial .gitignore-only changes (diff touches only .gitignore and is a single-line add/remove of a pattern), (b) IDE-config-only commits (all changed files under .vscode/, .idea/, .fleet/, or similar per-developer directories), (c) lockfile-only changes without corresponding package.json/pyproject.toml/Cargo.toml changes (e.g., npm install refreshing package-lock.json). Each as a small predicate function returning { shouldSuppress, reason }. Configurable toggle per rule via config.capture.classifier, default on. See inbox draft q_1776646621_52 (once confirmed) for full Shape 2 rationale.

## 8. v1.3.0 — Classifier learning layer (thresholded suppression proposals)

The learning half of Shape 2. Background pass during context-ledger tidy (or new CLI context-ledger classifier review) reads dismissed inbox items from the last 60 days, clusters by change_category + rejection_reason similarity (tokenized overlap, not LLM), and emits classifier_proposal inbox items when a cluster crosses threshold (default 5 rejections). Proposals surface as question_needed items; user confirm appends to config.capture.classifier.learned_suppression_rules, user dismiss applies cooldown on the cluster. New inbox_type: "classifier_proposal" (strictly additive). Rollback via context-ledger classifier rules list/remove CLI and matching MCP tools. Hard cap: 1 active proposal per repo at a time. Requires empty-rejection-reason filter to avoid polluting signal with sloppy dismissals. See inbox draft q_1776646621_52 for full rationale.
