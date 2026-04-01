# CLAUDE.md — context-ledger

## Project Overview
context-ledger is a decision capture and retrieval system for AI-assisted development.
It captures the "why" behind architectural choices and makes them retrievable via MCP.

NPM package name: context-ledger
GitHub: https://github.com/russellmoss/context-ledger

## Tech Stack
- Node.js 18+ (ES modules, "type": "module")
- TypeScript (strict mode, Node16 module resolution)
- MCP SDK (@modelcontextprotocol/sdk)
- @clack/prompts (setup wizard only)
- Storage: local JSONL (event-sourced, append-only)
- Zero other runtime dependencies

## Critical Rules
- All imports use .js extensions (Node16 resolution)
- JSONL writes are ALWAYS append-only with trailing newline — never mutate existing lines
- All events must conform to the schema in context-ledger-design-v2.md
- MCP tools must include annotations (readOnlyHint, destructiveHint, openWorldHint)
- No console.log in src/index.ts — stdout is reserved for MCP JSON-RPC. Use console.error for diagnostics.
- The post-commit hook must execute in under 100ms. Zero LLM calls. Zero network calls.
- Lifecycle transitions must follow the state machine: superseded is terminal, abandoned/expired can reopen, no cycles.
- Auto-promotion threshold: only records with retrieval_weight >= 0.7 and durability = "precedent" can drive autonomous behavior.

## Design Spec
The authoritative design document is: context-ledger-design-v2.md (in project root)
It contains all event schemas, lifecycle rules, retrieval contracts, MCP tool interfaces,
and 47 traced design decisions from 4 rounds of adversarial review.
ALWAYS check the design spec before implementing new features.

## Development Workflow
- /auto-feature — full exploration + planning + council review pipeline
- /council — send implementation plan to GPT + Gemini for adversarial review
- /refine — apply council feedback to implementation plan
- /quick-update — lightweight changes (1-5 files, no council review needed)
- Always run npx agent-guard sync after code changes pass build
- Always execute implementation guides in a FRESH Claude Code instance to avoid context contamination

## Ecosystem Integration
- agent-guard owns: current factual state (inventories, doc sync, session context)
- context-ledger owns: durable rationale (decisions, precedents, abandoned approaches)
- council-of-models-mcp owns: adversarial review (cross-LLM validation)
- Loading order: agent-guard factual docs first, then context-ledger decision packs

## Module Boundaries
- src/ledger/ — Event types, fold logic, inbox management, validation. This is the core data model.
- src/capture/ — Post-commit hook, change classification. Instantaneous, deterministic.
- src/retrieval/ — query_decisions, scope derivation, decision packs. File-path-first.
- src/mcp/ — MCP tool registrations. Read tools and write tools with idempotency.
- src/cli.ts — CLI commands. User-facing output.
- src/setup.ts — Interactive wizard. @clack/prompts only.
- src/config.ts — Configuration defaults. Single source of truth for defaults.

---

## Documentation Maintenance — Standing Instructions

### Rule: Update Docs When You Change Code

When you add, rename, remove, or significantly modify any of the following, you MUST update the relevant documentation **in the same session** — do not defer to a later task:

| If You Changed… | Update This | And Run… |
|---|---|---|
| `.env` | Environment Variables section in `docs\ARCHITECTURE.md` | Run `npm run gen:env` |
| `src/*` | Architecture section in `docs\ARCHITECTURE.md` | — |

### Generated Inventories

Auto-generated inventory files exist at `docs\_generated\`:
- `npm run gen:env`
- Run all: `npm run gen:all`

These are committed to the repo. Always regenerate after changing routes, models, or env vars.

### Pre-Commit Hook Behavior
- If the pre-commit hook is in **blocking mode** (`autoFix.hook.mode: "blocking"`), you MUST update documentation BEFORE committing. The hook will exit 1 and reject the commit if docs are stale. Run generators and update narrative docs first, then commit.
- When you (an AI agent) trigger a commit, the hook detects this and skips all AI engines to prevent self-invocation. If docs are stale, the commit will be rejected with exit 1. Read the changed source files, update the relevant sections in docs/ARCHITECTURE.md (and any other doc targets) yourself, stage with git add, then retry the commit. Do NOT run npx agent-guard sync — update the files yourself directly.

### What NOT to Do
- Do NOT edit files in `docs\_generated\` manually — they are overwritten by scripts
- Do NOT skip documentation updates because "it's a small change" — small changes accumulate into drift
- Do NOT update `docs\ARCHITECTURE.md` without reading the existing section first — match the format

### Session Start
- At the start of every session, if `.agent-guard/session-context.md` exists, read it before making any code changes. It contains a summary of recent commits, what documentation was updated, and patterns to be aware of.
- Do NOT edit `.agent-guard/session-context.md` — it is auto-generated on every commit.
