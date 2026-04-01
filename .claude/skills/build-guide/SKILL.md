---
name: build-guide
description: "Build an agentic implementation guide from exploration results. Creates a phased, validation-gated guide for context-ledger features."
---

# Build Agentic Implementation Guide — context-ledger

You are building an implementation guide from completed exploration results. The guide must be executable by a single Claude Code agent working phase-by-phase with human checkpoints.

## Prerequisites
Verify these exploration files exist:
- exploration-results.md
- code-inspector-findings.md
- pattern-finder-findings.md

Read ALL of them.

## Reference Document
The design spec is the single source of truth: context-ledger-design-v2.md
All event schemas, lifecycle rules, retrieval contracts, and MCP tool interfaces are defined there.

## Guide Structure
Create agentic_implementation_guide.md with:

### Standard Phase Order

**Phase 1: Blocking Prerequisites**
- Any infrastructure that must exist before feature code

**Phase 2: Type Definitions**
- Update TypeScript interfaces in src/ledger/events.ts or relevant type files
- This INTENTIONALLY breaks the build — errors become the checklist
- Validation gate: COUNT errors and list which files have them

**Phase 3: Core Logic**
- Event handling, fold logic, classification, scope derivation
- Whatever the feature's core algorithm is

**Phase 4: MCP Tool Integration**
- Register or update MCP tools in src/mcp/
- Wire up to core logic from Phase 3

**Phase 5: CLI Integration**
- Wire feature into src/cli.ts commands if applicable

**Phase 6: Documentation Sync**
Run: npx agent-guard sync
Review changes. Stage if correct.

**Phase 7: Validation**
- npm run build must pass with ZERO errors
- Smoke test if applicable
- Manual verification steps

### Critical Rules
1. Every construction site must be covered.
2. Validation gates must have concrete bash commands.
3. Import merges, not additions.
4. All events must conform to the schema in context-ledger-design-v2.md.
5. JSONL writes are always append-only with trailing newline.
6. MCP tools must include annotations (readOnlyHint, destructiveHint, openWorldHint).
7. Agent-guard sync before final validation.
