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
- src/capture/ — Post-commit hook, change classification (classify.ts, hook.ts, index.ts)
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
- **Classifier** (classify.ts): Deterministic commit classifier with 8 Tier 1 categories (dependency-addition, dependency-removal, env-var-change, new-directory, file-deletion, config-change, api-route-change, schema-change) and 4 Tier 2 categories (module-replacement, auth-security-change, db-migration-switch, feature-removal). Supports package.json content diff parsing for accurate dependency detection. 3-item cap per commit with Tier 2 priority.
- **Hook** (hook.ts): Post-commit entry point executing under 100ms. Consolidated git diff-tree parsing with NUL-delimited output, merge commit skipping, path normalization, Tier 2 contradiction detection (best-effort with foldLedger size gate), redaction via config patterns, and append-only inbox writes. Debug output via CONTEXT_LEDGER_DEBUG env var.
- **Exports** (index.ts): Barrel exports for ClassifyResult, ParsedPackageJson, classifyCommit, postCommit.

### Configuration System
- **Deep Merge**: Hierarchical config loading with type-safe defaults
- **Scope Mappings**: File path to scope derivation rules
- **Feature Hints**: Query expansion mappings for retrieval
- **Environment Variables**: Supports CONTEXT_LEDGER_PROJECT_ROOT for custom project root configuration, CONTEXT_LEDGER_DEBUG for verbose hook stderr output

## Ecosystem
- agent-guard: Keeps the "what" accurate (inventories, doc sync, session context)
- context-ledger: Keeps the "why" accessible (decisions, precedents, abandoned approaches)
- council-of-models-mcp: Keeps the "review" adversarial (cross-LLM validation)