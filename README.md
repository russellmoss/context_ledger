# context-ledger

Decision capture and retrieval system for AI-assisted development.

Captures the *why* behind architectural choices and makes that reasoning retrievable 
via MCP so AI agents stop repeating mistakes and stop asking the same design questions 
on every feature.

## Status: Pre-release (building)

This package is under active development. See context-ledger-design-v2.md for the 
full design specification.

## Quick Start

```bash
# Install
npm install context-ledger

# Initialize in your project
npx context-ledger init

# Start MCP server
npx context-ledger serve

# Query decisions from CLI
npx context-ledger query "database choice"

# View statistics
npx context-ledger stats
```

## Features

- **Event-sourced ledger** with append-only JSONL storage
- **MCP server** with read/write tools for AI agent integration
- **CLI interface** with validation, statistics, and backfill commands
- **Post-commit hooks** for automatic change detection
- **Decision lifecycle** with supersession, abandonment, and auto-expiry
- **Scope-based organization** with file path derivation
- **Inbox workflow** for decision review and confirmation

## Ecosystem

context-ledger is the third tool in a composable ecosystem:

- **[agent-guard](https://www.npmjs.com/package/@mossrussell/agent-guard)** — keeps the *what* accurate
- **context-ledger** — keeps the *why* accessible  
- **[council-of-models-mcp](https://www.npmjs.com/package/council-of-models-mcp)** — keeps the *review* adversarial

## License

ISC