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
- **Read Tools**: query_decisions with decision pack output
- **Write Tools**: propose_decision, confirm_pending, reject_pending, supersede_decision, record_writeback
- **Validation**: Zod schemas for all tool parameters with detailed descriptions
- **Error Handling**: Structured error responses with diagnostic logging

### CLI Interface
- **Command Dispatch**: Full feature CLI with help system and version reporting
- **Validation**: Integrity checking with repair suggestions and strict/lenient modes
- **Backfill**: Git history analysis with structural commit detection and resumable processing
- **Statistics**: Decision analytics with grouping by source, kind, scope, evidence, and lifecycle state

### Capture System
- **Classifier** (classify.ts): Deterministic commit classifier with 9 Tier 1 categories (dependency-addition, dependency-removal, env-var-change, new-directory, file-deletion, config-change, api-route-change, page-route-change, schema-change) and 4 Tier 2 categories (module-replacement, auth-security-change, db-migration-switch, feature-removal). `AUTH_FILE_PATTERN` requires compound forms (`session-store`, `session-manager`, `auth-session`, `session-cookie`) to avoid false positives on bare "session" filenames. API routes (`app/api`, `pages/api`, `src/routes`) and Next.js page routes (`page.tsx`) are classified independently, with files claimed by one result excluded from the other. Supports package.json content diff parsing for accurate dependency detection. 3-item cap per commit with Tier 2 priority.
- **Hook** (hook.ts): Post-commit entry point. Single `git diff-tree --no-commit-id --root -r --name-status -z HEAD` for NUL-delimited output parsing, merge commit skipping, path normalization, Tier 2 contradiction detection (best-effort with foldLedger size gate), redaction via config patterns, and append-only inbox writes. For every `draft_needed` result the hook also invokes the LLM drafter (see below) with the commit diff via `git show --unified=3 <sha> -- <files>` and attaches the returned `proposed_decision` to the inbox record. Commits touching `.env*`, `credentials*`, `*.key`, `*.pem` skip draft synthesis entirely. Debug output via CONTEXT_LEDGER_DEBUG env var.
- **Drafter** (drafter.ts): Calls Claude Haiku (`claude-haiku-4-5-20251001` by default) via the Anthropic SDK with `tool_choice` forcing a single `propose_decision` tool call, producing a structured `ProposedDecision`. Reads the API key from `process.env.ANTHROPIC_API_KEY` only (never from config.json). Returns `null` on missing key, timeout, rate limit, auth failure, schema validation failure, or any other error — never throws. Diff is truncated to `max_diff_chars` (default 8000) with a `...[truncated]` marker. All errors logged to stderr under `[context-ledger:drafter]`.
- **Exports** (index.ts): Barrel exports for ClassifyResult, ParsedPackageJson, classifyCommit, postCommit.
- **Tests** (smoke-test.ts / drafter.test.ts / hook.test.ts): Standalone Node scripts. Classifier smoke verifies bare "session" does not trigger auth, compound forms do, page.tsx and api routes produce separate results without double-claiming files. Drafter unit tests cover null-apiKey short-circuit, successful tool_use parsing, error swallowing, and diff truncation (Anthropic SDK mocked by patching `Messages.prototype.create`). Hook integration tests spin up a temp git repo and assert that `draft_needed` inbox items gain a `proposed_decision` when the drafter returns one and omit the field when the API key is absent.

### Configuration System
- **Deep Merge**: Hierarchical config loading with type-safe defaults
- **Scope Mappings**: File path to scope derivation rules
- **Feature Hints**: Query expansion mappings for retrieval
- **Environment Variables**: 
  - `CONTEXT_LEDGER_PROJECT_ROOT`: Override default project root detection when running from outside project directory (used in cli.ts, mcp-server-bin.ts, and capture/hook.ts)
  - `CONTEXT_LEDGER_DEBUG`: Enable verbose hook stderr output for debugging (used in capture/hook.ts)
  - `ANTHROPIC_API_KEY`: Enables the LLM drafter. When set, the post-commit hook calls Claude Haiku to synthesize a `proposed_decision` for each `draft_needed` inbox item. Feature degrades to a no-op when unset. Read only from the environment — never from config.json (used in capture/drafter.ts via capture/hook.ts).

## Ecosystem
- agent-guard: Keeps the "what" accurate (inventories, doc sync, session context)
- context-ledger: Keeps the "why" accessible (decisions, precedents, abandoned approaches)
- council-of-models-mcp: Keeps the "review" adversarial (cross-LLM validation)