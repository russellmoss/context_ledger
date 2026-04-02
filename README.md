# context-ledger

Your AI agent has amnesia. Every new feature, it forgets what you already decided, proposes approaches you already tried and abandoned, and asks the same design questions you answered three features ago. context-ledger fixes that. It captures architectural decisions and makes them queryable via MCP so your agent gets smarter with every feature instead of starting from zero.

## The Problem

AI-assisted development has three failure modes that get worse as your project grows:

**Your agent works from stale context.** It reads the code but doesn't know *why* the code is that way. It proposes replacing your carefully-chosen event-sourcing pattern with a simple database because it can't see the six weeks of debugging that led you there.

**Your agent won't argue with you.** It agrees with your plan even when you're about to repeat a mistake. You tried the "clever" approach to scope derivation on Feature 3, hit a wall, and abandoned it. Your agent doesn't know that. It'll happily help you build it again on Feature 9.

**Your agent has amnesia.** You answer "use COALESCE with sensible defaults, don't filter NULLs" on Feature 1 and get asked the exact same question on Feature 7. Every feature, the pile of "Bucket 2" human input questions grows because more areas of the codebase have conventions your agent doesn't know about.

context-ledger solves all three. Decisions go in, they compound over time, and your agent stops asking questions it already has answers to.

## The Ecosystem

context-ledger is part of a three-tool composable ecosystem. Each tool solves a different problem. They work great together but don't require each other.

| Tool | What It Knows | npm |
|------|---------------|-----|
| **agent-guard** | What IS (current codebase state, docs, inventories) | `@mossrussell/agent-guard` |
| **context-ledger** | What was DECIDED and what FAILED (decisions, precedents, abandoned approaches) | `@mossrussell/context-ledger` |
| **council-of-models-mcp** | Whether the plan is any GOOD (adversarial review via GPT + Gemini) | `council-of-models-mcp` |

Together: your AI agent starts every session knowing what exists, why it exists that way, and whether its plan to change it has been stress-tested.

## What context-ledger Actually Does

It's an event-sourced decision ledger with an MCP interface. In plain English:

**Captures architectural decisions.** When you make a choice ("use append-only JSONL, not SQLite"), it records the decision, the alternatives you considered, why you rejected them, and the conditions under which you'd revisit.

**Records what failed.** When you abandon an approach, it captures the pain points. Next time an agent proposes the same thing, it gets back "this was tried and abandoned because X, Y, Z."

**Makes decisions retrievable via MCP.** Claude Code, Cursor, Windsurf, or any MCP client can query the ledger by file path, scope, or natural language. The agent gets back a "decision pack" with active precedents, abandoned approaches, and gaps where no precedent exists.

**Compounds over time.** Each feature you build adds to the precedent history. The more decisions you capture, the fewer "Bucket 2" human input questions come up on the next feature. Your agent learns your project's conventions.

**Zero infrastructure.** Everything is append-only JSONL files in a `.context-ledger/` directory. Git-trackable. No database, no server, no cloud dependency.

## Quick Start

Five minutes from "what is this" to "it's running."

### 1. Install

```bash
npm install -g @mossrussell/context-ledger
```

Or project-local:

```bash
npm install --save-dev @mossrussell/context-ledger
```

### 2. Initialize

```bash
npx context-ledger init
```

This creates `.context-ledger/` with a default config, and installs a post-commit hook (auto-detects Husky, Lefthook, simple-git-hooks, or bare `.git/hooks/`).

### 3. Register the MCP Server

For Claude Code:

```bash
claude mcp add --scope user context-ledger-mcp -- npx context-ledger-mcp
```

For other MCP clients, point them at the `context-ledger-mcp` binary over stdio.

### 4. Test It

Start a new Claude Code session and ask:

> "Use query_decisions with query 'architecture' to check for existing decisions."

If your ledger is empty, you'll get back an empty pack. Time to capture your first decision.

### 5. Capture Your First Decision

The fastest path: tell your AI agent to use `propose_decision` to draft a decision about something you've already established in your project. Then use `confirm_pending` to promote it to the ledger.

Or use the `record_writeback` tool during a normal feature workflow. When the agent makes a design choice during implementation, it writes that choice back to the ledger automatically.

## How It Works

The core loop is: **capture, store, fold, retrieve, compound.**

**Capture.** Decisions enter the system from multiple sources. Manual entry, workflow write-back (your agent records its own choices during implementation), commit inference (the post-commit hook flags structural changes), or batch backfill from git history.

**Store.** Everything is an append-only event in JSONL. Two event types: `decision` (the actual choice) and `transition` (state changes like supersede, abandon, expire, reinforce). Events are never mutated or deleted. The inbox (`inbox.jsonl`) holds pending drafts and questions.

**Fold.** The "fold" computes current state from the event log. It walks every event in order and produces a materialized view: which decisions are active, which are superseded, which were abandoned, what the effective ranking scores are. Think of it like a git log that computes the current state of the repo.

**Retrieve.** AI agents query via MCP and get back a "decision pack": active precedents that apply to their current scope, abandoned approaches to avoid, recently superseded decisions for context, and pending inbox items to surface. Scope is derived from file paths, config mappings, or natural language hints.

**Compound.** Every decision you capture makes the next feature faster. The agent asks fewer questions because it already has precedent. It avoids dead ends because abandoned approaches are flagged. It reinforces good patterns because confirmed decisions get ranking boosts.

## MCP Tools

### Read

| Tool | Purpose |
|------|---------|
| `query_decisions` | Primary retrieval. Derives scope from file paths, config mappings, or query text. Returns a decision pack with active precedents, abandoned approaches, superseded history, and inbox items. Token-budgeted. |

### Write

All write tools require a `client_operation_id` for idempotency.

| Tool | Purpose |
|------|---------|
| `propose_decision` | Draft a decision for developer confirmation. Writes to inbox. |
| `confirm_pending` | Confirm an inbox item and promote it to the ledger. |
| `reject_pending` | Dismiss an inbox item. |
| `supersede_decision` | Replace an active decision with a new one. Captures pain points. |
| `record_writeback` | Workflow write-back. Reinforces existing precedent if found, surfaces conflicts, or creates a new record. |

## CLI Reference

### Read Commands

```bash
context-ledger query "event sourcing"       # Lexical search, active decisions only
context-ledger stats                         # Decision counts by source, kind, scope, evidence type, state
context-ledger export --format json          # Materialized decisions with current state and scores
context-ledger export --format csv           # CSV with standard columns
context-ledger export --format jsonl         # Raw ledger events
```

### Validation

```bash
context-ledger validate                      # Integrity check (malformed JSONL, orphans, lifecycle violations)
context-ledger validate --propose-repair     # Suggest repairs without modifying files
```

### Write Commands

```bash
context-ledger init                          # Create .context-ledger/, config, post-commit hook
context-ledger tidy                          # Remove stale inbox entries older than 30 days
context-ledger backfill --max 5              # Backfill structural commits from git history
context-ledger backfill --resume             # Resume interrupted backfill
```

### Other

```bash
context-ledger serve                         # Start MCP server over stdio
context-ledger --help                        # Full command list
context-ledger --version                     # Package version
```

## Decision Lifecycle

Decisions follow a state machine:

```
active --> superseded    (terminal, no reopen)
active --> abandoned     (can reopen)
active --> expired       (can reopen)
active --> reinforced    (stays active, ranking boost)
```

**Superseded** means a newer decision replaced it. This is terminal. The old decision stays in the history with its `replaced_by` pointer so agents can trace the evolution.

**Abandoned** means you tried it and it didn't work. Pain points get captured. Agents see these in the "abandoned approaches" section of decision packs, which prevents them from re-proposing the same thing.

**Reinforced** means an agent encountered an existing precedent during a workflow and reaffirmed it. The decision gets a small ranking boost (capped at +0.15) so it surfaces more prominently in future queries.

See `context-ledger-design-v2.md` for the full specification.

## Using with agent-guard

agent-guard and context-ledger have complementary responsibilities:

- **agent-guard** keeps the "what" accurate: generated inventories, documentation drift enforcement, session recaps
- **context-ledger** keeps the "why" accessible: decisions, precedents, abandoned approaches, pain points

When both are loaded, agent-guard's factual docs load first (inventories, session context), then context-ledger's decision packs for scoped rationale. Your agent starts every session knowing what exists AND why it exists that way.

```bash
# Install both
npm install --save-dev @mossrussell/agent-guard @mossrussell/context-ledger

# Register both MCP servers
claude mcp add --scope user context-ledger-mcp -- npx context-ledger-mcp
```

agent-guard handles what changed since last session. context-ledger handles why things are the way they are. No overlap, full coverage.

## Using with council-of-models-mcp

The `/auto-feature` workflow uses all three tools together:

1. **Exploration** (agent-guard provides current codebase state, context-ledger provides existing decisions)
2. **Planning** (implementation guide built with precedent awareness)
3. **Council Review** (council-of-models-mcp sends the plan to GPT and Gemini for adversarial review)
4. **Triage** (Bucket 2 human answers get written back to context-ledger via `record_writeback`)
5. **Next feature** benefits from those answers without asking again

The loop tightens over time. Feature 1 might have 8 Bucket 2 questions. Feature 10 might have 2, because 6 of those questions now have precedent answers in the ledger.

```bash
# The full ecosystem
npm install --save-dev @mossrussell/agent-guard @mossrussell/context-ledger council-of-models-mcp
```

## Configuration

`context-ledger init` creates `.context-ledger/config.json` with sensible defaults:

```jsonc
{
  "capture": {
    "enabled": true,
    "ignore_paths": ["dist/", "node_modules/", ".next/", "coverage/"],
    "scope_mappings": {},          // Map file paths to named scopes
    "no_capture_marker": "[no-capture]",
    "inbox_ttl_days": 14,
    "inbox_max_prompts_per_item": 3
  },
  "retrieval": {
    "default_limit": 20,
    "include_superseded": false,
    "auto_promotion_min_weight": 0.7,
    "token_budget": 4000,
    "feature_hint_mappings": {}    // Map keywords to scope IDs
  }
}
```

Scope mappings let you give meaningful names to areas of your codebase. Without them, scope is derived from directory names. With them, `src/ledger/` maps to `domain/ledger-core` and queries become much more precise.

## Environment Variables

The following environment variables can be used to configure context-ledger behavior:

- `CONTEXT_LEDGER_PROJECT_ROOT`: Override the default project root detection when the tool is run from outside the project directory
- `CONTEXT_LEDGER_DEBUG`: Enable verbose hook stderr output for debugging capture operations

See `context-ledger-design-v2.md` for the full config schema and all options.

## License

ISC

## Author

Russell Moss

- GitHub: [russellmoss](https://github.com/russellmoss)
- npm: [@mossrussell](https://www.npmjs.com/~mossrussell)