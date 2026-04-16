# Changelog

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
