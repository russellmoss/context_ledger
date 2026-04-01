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

## Architecture
- Entry points: CLI (cli.ts), MCP Server (index.ts), Setup Wizard (setup.ts)
- Ledger: Event-sourced JSONL with decision records and transition events
- Inbox: Structured JSONL queue with TTL and lifecycle management
- Capture: Post-commit hook (instantaneous, zero LLM calls) + workflow write-back
- Retrieval: MCP server with file-path-first scope derivation and decision packs
- Integration: Designed to work alongside agent-guard and council-of-models-mcp

## Key Design Decisions
See context-ledger-design-v2.md for the full design spec with 47 traced decisions 
from 4 rounds of adversarial review.

## Module Map
- src/ledger/ — Event types, fold logic, inbox management, validation
- src/capture/ — Post-commit hook, change classification
- src/retrieval/ — query_decisions, scope derivation, decision pack builder
- src/mcp/ — MCP tool registrations (read + write tools)
- src/cli.ts — CLI commands (init, validate, tidy, stats, export, backfill)
- src/setup.ts — Interactive setup wizard (@clack/prompts)
- src/config.ts — Default configuration, scope mappings, hint mappings

## Ecosystem
- agent-guard: Keeps the "what" accurate (inventories, doc sync, session context)
- context-ledger: Keeps the "why" accessible (decisions, precedents, abandoned approaches)
- council-of-models-mcp: Keeps the "review" adversarial (cross-LLM validation)
