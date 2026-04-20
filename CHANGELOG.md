# Changelog

## v1.2.2 — 2026-04-19

- **retrieval**: Cross-scope supersede history now surfaces in `recently_superseded` when the replacement record is in the query scope, even at default params (`include_superseded: false`). Cross-scope entries are scoped-by-definition to the query (their replacement is in scope) and are genealogy rather than stale history. Same-scope superseded records continue to require `include_superseded: true`. Opt out per query via the new `include_cross_scope_supersede: false` parameter (default `true`). One-hop traversal only. New `MatchReason` value `cross_scope_supersede` marks these entries.
- **retrieval**: `deriveScope` now returns `{ type: "directory", id: "packages/<pkg>", source: "monorepo_root" }` for file paths under common monorepo roots (`packages/`, `apps/`, `services/`) when no `scope_mappings` entry matches. Previously returned the basename via `directory_fallback`. Behavior improvement: `derived_scope` reported in the decision pack is now useful on monorepo paths. Original `directory_fallback` preserved for non-monorepo paths. The `inboxItemIntersectsScope` mirror in `src/retrieval/query.ts` was updated in lockstep — `mistakes_in_scope` and dismissed-inbox entries now resolve correctly on monorepo-root queries.
- **classify**: Three new deterministic seed rules suppress whole-commit classification when the changeset is non-actionable. Configurable via `capture.classifier.seed_rules.{gitignore_trivial, ide_config_only, lockfile_only}` — all default `true`. `gitignore_trivial` fires when any `.gitignore` (root or subdirectory) is the only file in the commit and the diff is a single-line add/remove. `ide_config_only` fires when every file lives under `.vscode/`, `.idea/`, `.fleet/`, or `.devcontainer/` (`.github/` deliberately excluded to preserve CI workflow classification). `lockfile_only` fires when only lockfiles change (`package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`, `poetry.lock`, `Cargo.lock`, `Gemfile.lock`, `go.sum`) with no matching-directory manifest in the changeset — per-directory comparison so monorepo sibling packages don't false-negative the rule. Hook adds a single conditional `git diff --numstat` call, fired only when a sole `.gitignore` is present and `HEAD~1` exists — budget preserved.
- **mcp**: `query_decisions` tool input schema gains `include_cross_scope_supersede?: boolean` (default `true`). Tool annotations (`readOnlyHint`, `destructiveHint`, `openWorldHint`) unchanged.
- **config**: `ClassifierCaptureConfig` gains `seed_rules?: SeedRulesConfig`. Additive — existing configs continue to work with defaults filled in via `deepMerge`.
- **schema**: Purely additive. No changes to `ledger.jsonl` event schema. No changes to MCP tool annotations. No new runtime dependencies.
- **spec**: `context-ledger-design-v2.md` bumped v2.4.1 → v2.4.2 with three decision-table entries (Source: `dogfood 2026-04-19 to 2026-04-20`).

## v1.2.1 — 2026-04-19

- **capture**: Hook-drafted inbox items now populate `scope_type`, `scope_id`, `affected_files`, and `scope_aliases` at draft time via the existing `deriveScope` helper. Draft items become retrievable via file-path queries and `mistakes_in_scope` — previously they only surfaced via broad recency fallback.
- **capture**: Inbox draft payload key unified on `proposed_record`. The hook drafter previously wrote under `proposed_decision`; the MCP `propose_decision` tool already wrote under `proposed_record`. Readers fall back to `proposed_decision` for legacy data — no migration required, forward-migrate-on-read only.
- **capture**: Hook drafter suppresses drafts on same-day revert pairs. Configurable via `capture.drafter.revert_suppression_window_hours` (default 24). Detection keys off the commit body (`This reverts commit <40-char SHA>`), uses committer date (`%ct`), and fails open on git errors. Timing semantics: the suppression fires when the revert lands, so a feat drafted moments earlier stays in the inbox — net effect halves the noise, it does not retroactively erase the feat's draft (which would violate append-only).
- **classify**: `file-deletion` Tier 1 classifier suppresses commits whose deletions are entirely editor-backup or OS-noise files. Configurable via `capture.classifier.editor_backup_patterns` (default `*.bak`, `*.orig`, `*.swp`, `*.swo`, `*~`, `.#*`, `.DS_Store`, `Thumbs.db`). Mixed commits (backup + real source deletion) still classify the real deletion. Patterns are filename-segment-only.
- **cli**: `context-ledger query` renders `scope: <type>/<id>` on pending inbox items when the draft payload carries scope fields, making Bug 8's population visible without inspecting JSONL.
- **schema**: Purely additive. `InboxItem.proposed_record?` added alongside legacy `InboxItem.proposed_decision?`. `ProposedDecisionDraft` extended with optional scope fields (`scope_type`, `scope_id`, `affected_files`, `scope_aliases`, `revisit_conditions`, `review_after`). No changes to `ledger.jsonl` event schema. No changes to MCP tool annotations. No new runtime dependencies.
- **spec**: `context-ledger-design-v2.md` bumped v2.4 → v2.4.1 with four decision-table entries (Source: `dogfood 2026-04-19`).

## v1.2.0 — 2026-04-19

- **retrieval (new)**: `query_decisions` response now includes `mistakes_in_scope`, a discriminated union of superseded decisions with non-empty `pain_points`, abandoned decisions, and rejected inbox drafts with `rejection_reason`. Surfaced first in CLI output; last casualty under token-budget trimming.
- **cli**: `context-ledger query <text>` now calls `queryDecisions` and renders the full decision pack (prior mistakes in scope → active precedents → abandoned → recently superseded → pending inbox), mirroring what the agent sees over MCP. Previous lexical-only output is gone; output format has changed.
- **mcp**: `query_decisions` gains an optional `include_feature_local` parameter that opts `feature-local` durability records into every section of the pack (bypasses the default file-path-match requirement globally). Tool annotations unchanged (`readOnlyHint: true, destructiveHint: false, openWorldHint: false`).
- **schema**: `rejection_reason` ratified as a typed optional field on `InboxItem`. The previous out-of-schema dynamic cast in `reject_pending` is removed. No new event types; `DecisionRecord` and `TransitionEvent` are untouched.
- **auto-promotion**: `commit_inferred` records (retrieval weight 0.2) remain excluded from all auto-promotion pathways, including `mistakes_in_scope` — unreviewed inferences never drive agent behavior, even as antipatterns.
- **spec**: `context-ledger-design-v2.md` bumped v2.3 → v2.4 with six new decision-table entries covering the above.

## v1.1.0 — 2026-04-16

- **drafter (new)**: The post-commit hook now calls Claude Haiku (`claude-haiku-4-5-20251001`) to synthesize a `proposed_decision` for each `draft_needed` inbox item, using the commit diff, commit message, and up to 10 existing precedents in the derived scope. Reviewers see a pre-drafted decision record to approve, edit, or reject instead of authoring from scratch.
- **auth**: Enabled by `ANTHROPIC_API_KEY` in the environment. No key — feature is a no-op and hooks continue to write empty-placeholder inbox items exactly as before (no behavior change for existing consumers).
- **config**: New `capture.drafter: { enabled, model?, timeout_ms?, max_diff_chars? }` block in `.context-ledger/config.json`. Defaults: `{ enabled: true }` with Haiku / 20s timeout / 8000-char diff truncation. The API key is never read from config — always from `process.env.ANTHROPIC_API_KEY`.
- **schema**: `InboxItem` gains an optional `proposed_decision` field (`summary`, `decision`, `rationale`, `alternatives_considered`, `decision_kind`, `tags`, `durability`). Purely additive; older consumers ignore it.
- **safety**: Commits touching `.env*`, `credentials*`, `*.key`, or `*.pem` skip draft synthesis entirely. Drafter errors (timeout, rate limit, auth) are logged to stderr under `[context-ledger:drafter]` and swallowed — the hook never fails a commit.
- **deps**: Adds `@anthropic-ai/sdk`.

Cost estimate: ~$0.01/commit with Haiku. Disable via `config.capture.drafter.enabled = false`.

## v1.0.1 — 2026-04-16

- **classify**: `AUTH_FILE_PATTERN` no longer matches bare `session`; now requires a compound form (`session-store`, `session-manager`, `auth-session`, `session-cookie`). Eliminates false positives on files like `session-context.md`.
- **classify**: `api-route-change` split into `api-route-change` (API handlers under `app/api`, `pages/api`, `src/routes`) and `page-route-change` (Next.js `page.tsx`). Files are not double-claimed across the two results.
- **config**: `DEFAULT_CONFIG.capture.ignore_paths` now includes `.agent-guard/`, `.cursor/`, `.claude/` — agent-metadata dirs that never contain architectural decisions. User overrides still replace the default array whole via deep-merge.

## v1.0.0

- Initial release.
