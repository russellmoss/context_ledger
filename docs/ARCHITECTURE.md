# context-ledger Architecture

## Overview
context-ledger is a decision capture and retrieval system for AI-assisted development. 
It records the "why" behind architectural choices and makes that reasoning retrievable 
via MCP so AI agents stop repeating mistakes.

## Tech Stack
- Runtime: Node.js 18+ (ES modules)
- Language: TypeScript (strict mode)
- MCP SDK: @modelcontextprotocol/sdk
- Interactive UI: @clack/prompts
- Storage: Local JSONL (event-sourced, append-only)
- Validation: Zod schemas for MCP tool parameters

## Architecture
- Entry points: CLI (cli.ts), MCP Server (mcp-server.ts + mcp-server-bin.ts)
- Ledger: Event-sourced JSONL with decision records and transition events
- Inbox: Structured JSONL queue with TTL and lifecycle management
- Capture: Post-commit hook (instantaneous, zero LLM calls) + workflow write-back
- Retrieval: MCP server with file-path-first scope derivation and decision packs
- Integration: Designed to work alongside agent-guard and council-of-models-mcp

## Key Design Decisions
See context-ledger-design-v2.md for the full design spec with 47 traced decisions 
from 4 rounds of adversarial review.

## Module Map
- src/ledger/ — Event types, fold logic, inbox management, validation, storage operations
- src/capture/ — Post-commit hook, change classification, LLM drafter (classify.ts, hook.ts, drafter.ts, index.ts)
- src/retrieval/ — query_decisions implementation, scope derivation, decision pack builder
- src/mcp/ — MCP tool registrations (read + write tools with Zod validation)
- src/cli.ts — CLI commands (init, serve, validate, tidy, stats, export, backfill, query)
- src/config.ts — Configuration loader with deep merge, scope mappings, hint mappings
- src/index.ts — Library entry point with re-exports
- src/mcp-server.ts — MCP server implementation
- src/mcp-server-bin.ts — Standalone MCP server binary

## Core Components

### Event System
- **Events**: DecisionRecord and TransitionEvent types with comprehensive type guards
- **Fold Logic**: Event replay with lifecycle state machine, auto-expiry, and integrity checking
- **Storage**: Append-only JSONL with line-by-line corruption handling

### MCP Integration
- **Read Tools**: query_decisions with decision pack output. v1.2.2 adds `include_cross_scope_supersede?: boolean` (default `true`): superseded records whose `replaced_by` points to a decision in the queried scope surface as `recently_superseded` with `match_reason: "cross_scope_supersede"` — these are genealogy of the in-scope record, not stale history. Same-scope superseded records continue to require `include_superseded: true`. One-hop traversal only.
- **Write Tools**: propose_decision, confirm_pending, reject_pending, supersede_decision, record_writeback. `confirm_pending` accepts both `proposed_record` (canonical, v1.2.1+) and legacy `proposed_decision` inbox payloads, deriving a real scope via `deriveScope` when legacy items lack scope fields (never stamps an `"unknown"` sentinel).
- **Validation**: Zod schemas for all tool parameters with detailed descriptions
- **Error Handling**: Structured error responses with diagnostic logging

### CLI Interface
- **Command Dispatch**: Full feature CLI with help system and version reporting
- **Query rendering**: `context-ledger query <text>` renders the full decision pack; pending inbox items emit a `scope: <type>/<id>` continuation line when the draft payload carries scope fields (reads `proposed_record` first, falls back to legacy `proposed_decision`).
- **Validation**: Integrity checking with repair suggestions and strict/lenient modes
- **Backfill**: Git history analysis with structural commit detection and resumable processing
- **Statistics**: Decision analytics with grouping by source, kind, scope, evidence, and lifecycle state

### Capture System
- **Classifier** (classify.ts): Deterministic commit classifier with 9 Tier 1 categories (dependency-addition, dependency-removal, env-var-change, new-directory, file-deletion, config-change, api-route-change, page-route-change, schema-change) and 4 Tier 2 categories (module-replacement, auth-security-change, db-migration-switch, feature-removal). `AUTH_FILE_PATTERN` requires compound forms (`session-store`, `session-manager`, `auth-session`, `session-cookie`) to avoid false positives on bare "session" filenames. API routes (`app/api`, `pages/api`, `src/routes`) and Next.js page routes (`page.tsx`) are classified independently, with files claimed by one result excluded from the other. The Tier 1 `file-deletion` branch suppresses commits whose every deletion matches `capture.classifier.editor_backup_patterns` (filename-segment globs; default `*.bak`, `*.orig`, `*.swp`, `*.swo`, `*~`, `.#*`, `.DS_Store`, `Thumbs.db`) — mixed commits still classify the real deletion. Patterns are precompiled to anchored regex once per invocation; malformed user patterns are skipped with a single-line stderr log. Supports package.json content diff parsing for accurate dependency detection. 3-item cap per commit with Tier 2 priority. **v1.2.2 seed rules** run before per-file classification and suppress whole-commit inboxing when the changeset is non-actionable: `gitignore_trivial` (the only file is a `.gitignore` — root or subdirectory — and the diff is a single line add/remove), `ide_config_only` (every file lives under `.vscode/`, `.idea/`, `.fleet/`, or `.devcontainer/`; `.github/` is intentionally excluded to preserve CI workflow classification), and `lockfile_only` (every file is a known lockfile — `package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`, `poetry.lock`, `Cargo.lock`, `Gemfile.lock`, `go.sum` — and no matching-directory manifest is present in the changeset). Rules evaluate in that declared order; first match wins and the classifier returns `[]` with a `console.error` reason. Each rule is independently toggleable via `capture.classifier.seed_rules.{gitignore_trivial, ide_config_only, lockfile_only}` (all default `true`). `lockfile_only` compares lockfile ↔ manifest within the SAME directory so monorepo sibling packages don't false-negative the rule.
- **Hook** (hook.ts): Post-commit entry point. Single `git diff-tree --no-commit-id --root -r --name-status -z HEAD` for NUL-delimited output parsing, merge commit skipping, path normalization, Tier 2 contradiction detection (best-effort with foldLedger size gate), redaction via config patterns, and append-only inbox writes. Hook emits drafts under the canonical `proposed_record` key (legacy `proposed_decision` readers still accepted) and populates `scope_type`, `scope_id`, `affected_files`, `scope_aliases` at draft time via the existing `deriveScope` helper (hoisted to the top of the per-result loop so every result carries real scope, not just drafted ones). Same-day revert pairs are suppressed via a bounded `execFileSync("git", ["log", ...])` shellout that keys off the commit body (`This reverts commit <40-char SHA>`), uses committer date (`%ct`), and honors `capture.drafter.revert_suppression_window_hours` (default 24); fails open on any git error. For every `draft_needed` result the hook also invokes the LLM drafter (see below) with the commit diff via `git show --unified=3 <sha> -- <files>` and attaches the returned draft to the inbox record. Commits touching `.env*`, `credentials*`, `*.key`, `*.pem` skip draft synthesis entirely. **v1.2.2**: when a sole `.gitignore` (root or subdirectory, basename match) is the only changed file, the hook fires a single additional `git diff --numstat HEAD~1 HEAD -- <path>` call via `parseGitignoreDiff()` (guarded by a `HEAD~1` rev-parse so the initial commit never errors; binary diffs and missing parent commits return `null`) and passes the result to `classifyCommit` as `gitignoreDiff`. The extra call is gated to the single-gitignore case to preserve the sub-100ms hook budget. Debug output via CONTEXT_LEDGER_DEBUG env var.
- **Drafter** (drafter.ts): Calls Claude Haiku (`claude-haiku-4-5-20251001` by default) via the Anthropic SDK with `tool_choice` forcing a single `propose_decision` tool call, producing a structured `ProposedDecision`. Reads the API key from `process.env.ANTHROPIC_API_KEY` only (never from config.json). Returns `null` on missing key, timeout, rate limit, auth failure, schema validation failure, or any other error — never throws. Diff is truncated to `max_diff_chars` (default 8000) with a `...[truncated]` marker. All errors logged to stderr under `[context-ledger:drafter]`.
- **Exports** (index.ts): Barrel exports for ClassifyResult, ParsedPackageJson, classifyCommit, postCommit.
- **Tests** (smoke-test.ts / drafter.test.ts / hook.test.ts / classify.test.ts): Standalone Node scripts. Classifier smoke verifies bare "session" does not trigger auth, compound forms do, page.tsx and api routes produce separate results without double-claiming files. `classify.test.ts` covers Bug 10 (backup-only deletion suppressed, mixed commits keep real deletions, custom patterns honored, backslash-path portability, `.#*` anchoring) and the v1.2.2 seed rules: `gitignore_trivial` (sole root/subdir `.gitignore` + single-line diff suppresses; multi-line diff or missing diff object does not; mixed with other files does not); `ide_config_only` (all-`.vscode/`/`.idea/` commits suppressed, mixed not, `.github/` NOT suppressed); `lockfile_only` (lockfile-only suppressed, lockfile + matching-directory manifest NOT suppressed even in monorepos, config toggle honored). Drafter unit tests cover null-apiKey short-circuit, successful tool_use parsing, error swallowing, and diff truncation (Anthropic SDK mocked by patching `Messages.prototype.create`). Hook integration tests spin up a temp git repo; Tests 5–6 verify `proposed_record` presence/absence based on the API key; Tests 7–8 exercise same-day revert suppression on a real git revert inside and outside the 24h window; Test 9 asserts scope fields are populated on hook-drafted items.

### Retrieval
- **Scope derivation** (retrieval/scope.ts): File path → scope in order: explicit `scope_mappings` hit, `scope_aliases` hit, **v1.2.2 monorepo-root fallback** (paths under `packages/`, `apps/`, or `services/` return `{ type: "directory", id: "<root>/<pkg>", source: "monorepo_root" }`), then the original basename `directory_fallback`. The mirror in `retrieval/query.ts::inboxItemIntersectsScope` was updated in lockstep so `mistakes_in_scope` and dismissed-inbox intersection resolve correctly on monorepo-root queries.
- **Decision pack** (retrieval/packs.ts): `MatchReason` type now includes `cross_scope_supersede`. The `recently_superseded` slot gates same-scope entries on `include_superseded` but surfaces cross-scope entries (replacement in scope) by default; per-query opt-out via `include_cross_scope_supersede: false`. Two new builder parameters — `effectiveIncludeSuperseded` and `effectiveIncludeCrossScope` — are resolved once in `queryDecisions` (with config fallback for `include_superseded`) to avoid split-brain between the filter loop and the pack builder.
- **Query** (retrieval/query.ts): One-hop cross-scope traversal happens only inside the `derivedScope !== null` branch. When a superseded record's `replaced_by` points to an in-scope decision, `matchReason` is set to `cross_scope_supersede`; missing replacement records (trimmed/corrupted ledger) are treated as "no match" and skipped.

### Configuration System
- **Deep Merge**: Hierarchical config loading with type-safe defaults
- **Scope Mappings**: File path to scope derivation rules
- **Feature Hints**: Query expansion mappings for retrieval
- **Drafter tuning**: `capture.drafter.revert_suppression_window_hours` (default 24) caps the same-day revert-pair suppression window; set to 0 to disable (a window of 0 never matches).
- **Classifier tuning**: `capture.classifier.editor_backup_patterns` (default `*.bak`, `*.orig`, `*.swp`, `*.swo`, `*~`, `.#*`, `.DS_Store`, `Thumbs.db`) — filename-segment globs that suppress Tier 1 `file-deletion` classification when every deleted file matches. Omit or override per project.
- **Classifier seed rules**: `capture.classifier.seed_rules.{gitignore_trivial, ide_config_only, lockfile_only}` (all default `true`) — whole-commit suppressions that run before per-file classification. Set any entry to `false` to disable that rule per project; omit the block entirely to keep defaults. See the Classifier section above for matching semantics.
- **Environment Variables**: 
  - `CONTEXT_LEDGER_PROJECT_ROOT`: Override default project root detection when running from outside project directory (used in cli.ts, mcp-server-bin.ts, and capture/hook.ts)
  - `CONTEXT_LEDGER_DEBUG`: Enable verbose hook stderr output for debugging (used in capture/hook.ts)
  - `ANTHROPIC_API_KEY`: Enables the LLM drafter. When set, the post-commit hook calls Claude Haiku to synthesize a `proposed_decision` for each `draft_needed` inbox item. Feature degrades to a no-op when unset. Read only from the environment — never from config.json (used in capture/drafter.ts via capture/hook.ts).

## Ecosystem
- agent-guard: Keeps the "what" accurate (inventories, doc sync, session context)
- context-ledger: Keeps the "why" accessible (decisions, precedents, abandoned approaches)
- council-of-models-mcp: Keeps the "review" adversarial (cross-LLM validation)