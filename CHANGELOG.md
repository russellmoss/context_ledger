# Changelog

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
