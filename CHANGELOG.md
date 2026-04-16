# Changelog

## v1.0.1 — 2026-04-16

- **classify**: `AUTH_FILE_PATTERN` no longer matches bare `session`; now requires a compound form (`session-store`, `session-manager`, `auth-session`, `session-cookie`). Eliminates false positives on files like `session-context.md`.
- **classify**: `api-route-change` split into `api-route-change` (API handlers under `app/api`, `pages/api`, `src/routes`) and `page-route-change` (Next.js `page.tsx`). Files are not double-claimed across the two results.
- **config**: `DEFAULT_CONFIG.capture.ignore_paths` now includes `.agent-guard/`, `.cursor/`, `.claude/` — agent-metadata dirs that never contain architectural decisions. User overrides still replace the default array whole via deep-merge.

## v1.0.0

- Initial release.
