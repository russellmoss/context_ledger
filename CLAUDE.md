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

## Quick Reference (from context-ledger-design-v2.md)

### Storage Layout

```
.context-ledger/
├── ledger.jsonl      # append-only event log (decisions + transitions)
├── inbox.jsonl       # structured pending queue (drafts + questions)
├── config.json       # scope mappings, redaction, retrieval settings
└── .gitkeep
```

### DecisionRecord Schema (type: "decision")

| Field | Type | Notes |
|-------|------|-------|
| type | `"decision"` | |
| id | string | `d_{unix}_{hex4}` |
| created | ISO 8601 | |
| source | enum | `"manual"`, `"workflow-writeback"`, `"commit-inferred"`, `"backfill"` |
| evidence_type | enum | See Evidence Types table |
| verification_status | enum | `"unreviewed"`, `"confirmed"`, `"corrected"`, `"rejected"` |
| commit_sha | string \| null | |
| summary | string | |
| decision | string | |
| alternatives_considered | `{approach, why_rejected, failure_conditions}[]` | |
| rationale | string | |
| revisit_conditions | string | |
| review_after | ISO 8601 \| null | Required if durability = `"temporary-workaround"` |
| scope | `{type, id}` | type: `"package"`, `"directory"`, `"domain"`, `"concern"`, `"integration"` |
| affected_files | string[] | |
| scope_aliases | string[] | Prior paths if files were renamed |
| decision_kind | string | Freeform label, not enum |
| tags | string[] | |
| durability | enum | `"precedent"`, `"feature-local"`, `"temporary-workaround"` |

### TransitionEvent Schema (type: "transition")

| Field | Type | Notes |
|-------|------|-------|
| type | `"transition"` | |
| id | string | `t_{unix}_{hex4}` |
| created | ISO 8601 | |
| target_id | string | Decision being transitioned |
| action | enum | `"supersede"`, `"abandon"`, `"expire"`, `"reopen"`, `"reinforce"` |
| replaced_by | string \| null | Required for `"supersede"` |
| reason | string | |
| pain_points | string[] \| null | What went wrong (on supersede/abandon) |
| source_feature_id | string \| null | On reinforce |

### Evidence Types → Retrieval Weight

| Evidence Type | Weight | Auto-promotion eligible? |
|---------------|--------|--------------------------|
| `human_answered` | 1.0 | Yes |
| `explicit_manual` | 1.0 | Yes |
| `workflow_writeback` | 0.9 | Yes |
| `corrected_draft` | 0.85 | Yes |
| `confirmed_draft` | 0.8 | Yes |
| `backfill_confirmed` | 0.7 | Yes |
| `commit_inferred` | 0.2 | **No** — context only |

### Durability

| Durability | Auto-promotion? | Notes |
|------------|----------------|-------|
| `precedent` | Yes | Project-wide convention |
| `feature-local` | No | Excluded from default queries, auto-expires 60 days |
| `temporary-workaround` | No | Requires `review_after` date |

### Lifecycle State Machine

```
active → supersede → superseded (TERMINAL — no reopen)
active → abandon → abandoned → reopen → active
active → expire → expired → reopen → active
active → reinforce → active (annotation only, no state change)
```

Invariants:
- `supersede` requires `replaced_by` referencing an existing decision
- No cycles: if A supersedes B, B cannot supersede A
- `reinforce` valid only on `active` decisions
- Duplicate identical transitions are idempotent no-ops

### Reinforce Ranking Formula

```
effective_rank_score = base_retrieval_weight + min(0.15, 0.05 * reinforcement_count)
```

Cap: 1.0. Ranking only — never overrides lifecycle, trust, or durability rules.

### Inbox Item Schema

| Field | Type | Notes |
|-------|------|-------|
| inbox_id | string | `q_{unix}_{hex2}` |
| type | enum | `"draft_needed"`, `"question_needed"` |
| created | ISO 8601 | |
| commit_sha | string | |
| commit_message | string | |
| change_category | string | e.g. `"dependency-addition"` |
| changed_files | string[] | |
| diff_summary | string | |
| priority | string | `"normal"` |
| expires_after | ISO 8601 | 14-day TTL |
| times_shown | number | Max 3 before `"ignored"` |
| last_prompted_at | ISO 8601 \| null | |
| status | enum | `"pending"`, `"confirmed"`, `"corrected"`, `"dismissed"`, `"expired"`, `"ignored"` |

Inbox rules: 14-day TTL, max 3 prompts/item, max 3 items shown/session, Tier 2 before Tier 1, recency tiebreaker.

### MCP Read Tools

**`query_decisions`** — Primary retrieval.

| Param | Type | Default |
|-------|------|---------|
| file_path | string? | Primary entry point — server derives scope |
| query | string? | Natural language, triggers broad fallback |
| scope_type | string? | Overrides file_path derivation |
| scope_id | string? | |
| decision_kind | string? | Soft filter |
| tags | string[]? | |
| include_superseded | bool | false |
| include_unreviewed | bool | false |
| limit | number | 20 |
| offset | number | 0 |

**`search_decisions`** — CLI/debugging only, lexical fallback.

### Scope Derivation Fallback Order

1. Explicit `scope_type` + `scope_id` params
2. `file_path` → `scope_mappings` → `scope_aliases` → directory name fallback
3. `feature_hint_mappings` phrase match against `query` string
4. Pure recency fallback (last resort)

### Decision Pack Response

```jsonc
{
  "derived_scope": { "type": "...", "id": "...", "source": "config_mapping|scope_alias|directory_fallback" },
  "active_precedents": [{ "record": {}, "match_reason": "scope_hit|file_path_hit|tag_match|broad_fallback", "retrieval_weight": 0.85 }],
  "abandoned_approaches": [],
  "recently_superseded": [],
  "pending_inbox_items": [],
  "no_precedent_scopes": [],
  "token_estimate": 1847,
  "truncated": false
}
```

Token budget: 4000 tokens/pack default. Trim order: active precedents → abandoned → superseded.

### MCP Write Tools

All write tools require `client_operation_id` for idempotency. Pattern: `{feature-slug}-{YYYYMMDD}-{random4chars}`.

| Tool | Purpose |
|------|---------|
| `propose_decision(client_operation_id, ...)` | Draft → inbox.jsonl for confirmation |
| `confirm_pending(inbox_id, client_operation_id, ...)` | Confirm inbox item → ledger.jsonl |
| `reject_pending(inbox_id, client_operation_id, reason?)` | Dismiss inbox item |
| `supersede_decision(target_id, replaced_by, client_operation_id, reason, pain_points?)` | Transition event. Target must be active, replacement must exist, no cycles. |
| `record_writeback(client_operation_id, source_feature_id, ...)` | Workflow write-back. Reinforce-first: check for existing precedent before creating new. Returns `{status: 'conflict_detected', ...}` if contradiction found. |

### Capture: Hook Classification

**Tier 1 — Draft + Confirm:**
- Dependency added/removed in package.json
- New env var in .env.example
- New directory with multiple files
- Files/directories deleted
- Config file changes (tsconfig, eslint, CI)
- New API route or page route
- DB schema changes

**Tier 2 — Must Ask:**
- Major module replacement (library swap)
- Changes contradicting active ledger decision (structural signals in same scope)
- Auth/security pattern changes
- DB migration or provider switch
- Feature/capability removal

**Ignored:** Content-only edits, test files (unless new dir), style/formatting, docs, `ignore_paths`, commits with `[no-capture]`.

### CLI Commands

| Command | Purpose |
|---------|---------|
| `context-ledger init` | Create `.context-ledger/`, config, install post-commit hook |
| `context-ledger serve` | Start MCP server over stdio |
| `context-ledger query <query>` | CLI query for debugging |
| `context-ledger stats` | Summary by source, kind, scope, evidence type |
| `context-ledger export --format json\|csv` | Dump ledger |
| `context-ledger validate` | Integrity check (JSON, orphans, state machine, stale refs) |
| `context-ledger validate --propose-repair` | Reviewable repair plan to stdout |
| `context-ledger validate --apply-repair` | Apply reviewed repair plan |
| `context-ledger tidy` | Compact inbox.jsonl (terminal entries > 30 days) |
| `context-ledger backfill --max 5` | Optional batch backfill, capped |
| `context-ledger backfill --resume` | Resume interrupted backfill |
| `context-ledger setup` | Interactive wizard (@clack/prompts) |

### Setup Wizard (5 Steps)

1. **Project Detection** — package.json, .claude/, agent-guard, council-mcp
2. **Scope Mapping Generation** — Scan dirs → auto-generate scope_mappings + feature_hint_mappings
3. **Hook Installation** — Detect hook system (Husky/Lefthook/bare), install post-commit
4. **Standing Instructions Injection** — Inject into CLAUDE.md/.cursorrules, respect agent-guard ordering
5. **First-Run Demo** — Sample query_decisions showing decision pack

### Config Structure (`.context-ledger/config.json`)

```jsonc
{
  "capture": {
    "enabled": true,
    "ignore_paths": ["dist/", "node_modules/", ".next/", "coverage/"],
    "scope_mappings": { "src/path/": { "type": "domain", "id": "name" } },
    "redact_patterns": ["(?i)(api[_-]?key|secret|token|password)\\s*[:=]\\s*\\S+"],
    "no_capture_marker": "[no-capture]",
    "inbox_ttl_days": 14,
    "inbox_max_prompts_per_item": 3,
    "inbox_max_items_per_session": 3
  },
  "retrieval": {
    "default_limit": 20,
    "include_superseded": false,
    "include_unreviewed": false,
    "auto_promotion_min_weight": 0.7,
    "token_budget": 4000,
    "feature_hint_mappings": { "keyword": ["scope-id"] }
  },
  "workflow_integration": {
    "selective_writeback": true,
    "check_inbox_on_session_start": true,
    "jit_backfill": true
  },
  "monorepo": { "package_name": null, "root_relative_path": null }
}
```

### Auto-Promotion Predicate (ALL must be true)

1. Matching decision has `retrieval_weight >= 0.7`
2. `durability: "precedent"`
3. Current derived state is `active`
4. Scope overlaps with the question's affected area
5. Agent can articulate why the precedent applies (not just "similar topic")

---

## Documentation Maintenance — Standing Instructions

### Rule: Update Docs When You Change Code

When you add, rename, remove, or significantly modify any of the following, you MUST update the relevant documentation **in the same session** — do not defer to a later task:

| If You Changed… | Update This | And Run… |
|---|---|---|
| `.env` | Environment Variables section in `docs/ARCHITECTURE.md` | Run `npm run gen:env` |
| `src/*` | Architecture section in `docs/ARCHITECTURE.md` | — |

### Generated Inventories

Auto-generated inventory files exist at `docs/_generated/`:
- `npm run gen:env`
- Run all: `npm run gen:all`

These are committed to the repo. Always regenerate after changing routes, models, or env vars.

### Pre-Commit Hook Behavior
- If the pre-commit hook is in **blocking mode** (`autoFix.hook.mode: "blocking"`), you MUST update documentation BEFORE committing. The hook will exit 1 and reject the commit if docs are stale. Run generators and update narrative docs first, then commit.
- When you (an AI agent) trigger a commit, the hook detects this and skips all AI engines to prevent self-invocation. If docs are stale, the commit will be rejected with exit 1. Read the changed source files, update the relevant sections in docs/ARCHITECTURE.md (and any other doc targets) yourself, stage with git add, then retry the commit. Do NOT run npx agent-guard sync — update the files yourself directly.

### What NOT to Do
- Do NOT edit files in `docs/_generated/` manually — they are overwritten by scripts
- Do NOT skip documentation updates because "it's a small change" — small changes accumulate into drift
- Do NOT update `docs/ARCHITECTURE.md` without reading the existing section first — match the format

### Session Start
- At the start of every session, if `.agent-guard/session-context.md` exists, read it before making any code changes. It contains a summary of recent commits, what documentation was updated, and patterns to be aware of.
- Do NOT edit `.agent-guard/session-context.md` — it is auto-generated on every commit.
