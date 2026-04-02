# Triage Results — CLI Implementation

## Bucket 1 — APPLY AUTONOMOUSLY

### C1: Stats missing decision_kind and verification_status
**Action:** Add `byKind` and `byVerification` groupings to handleStats(). Keep existing state/durability as bonus.

### C3: Git log pipe delimiter breaks on commit messages with "|"
**Action:** Change format to `%H%x00%s%x00%ai` and split on `\0`.

### C4: mcp-server.ts guard removal
**Action:** Make mcp-server.ts export-only. Create a new bin wrapper file `src/mcp-server-bin.ts` that imports and calls `startMcpServer`. Update package.json bin entry.

### C6: Validate doesn't report malformed JSONL
**Action:** Add raw JSONL line-by-line check before folding. Read file, split lines, try JSON.parse each, collect malformed line numbers.

### S1: validate --apply-repair marked in --help
**Action:** Mark as "(not yet implemented)" in --help output.

### S3: --format=value equals syntax
**Action:** Add helper function to parse both `--flag value` and `--flag=value` patterns.

### S4: Missing directory pre-flight check
**Action:** Add check at start of main() for commands that need .context-ledger/. Print "Run 'context-ledger init' first."

### S7: Sub-command help
**Action:** Check if --help appears in args after command name, print command-specific help.

### S8: Remove dynamic imports in backfill
**Action:** Use top-level imports instead of `await import(...)` inside loops.

### I2: Add smoke test list
**Action:** Expand Phase 7 with edge case tests.

### C2 (partial): Backfill scope grouping
**Action:** Group by top-level directory of changed files as lightweight approximation. Full scope-derived grouping deferred to capture/classify.ts implementation.

---

## Bucket 2 — NEEDS HUMAN INPUT

### D1: JSON export — raw events or materialized state?
Options:
- **A:** Raw JSONL events (spec says "dump ledger" — implies raw event log)
- **B:** Materialized FoldedDecision array with current_state and scores (more useful for analysis)
- **C:** Both — `json` for materialized, `jsonl` for raw events

### D3: Stale file references in validate — warning or error?
Options:
- **A:** Warning only (don't affect exit code) — old decisions referencing deleted files is normal history
- **B:** Error (exit 1) — current guide behavior, stricter

### D5: Tidy "older than 30 days" — from created date or status change?
Options:
- **A:** Use `created` date (current behavior, simpler, no schema change)
- **B:** Add `status_updated_at` field to InboxItem (more correct but schema change)

---

## Bucket 3 — NOTE BUT DON'T APPLY

- Typed command model for argv parsing — over-engineered for 10 simple commands
- Runtime schema validators for all persisted JSON — scope expansion, existing guards sufficient
- Helper constructors for InboxItem — single construction site doesn't justify
- CLI error boundaries with chalk — no runtime dependencies allowed
- Inbox append-only clarification — already resolved (inbox is mutable by design)
- Multiple active decisions in same scope — already labeled as "REVIEW suggestion" in guide
