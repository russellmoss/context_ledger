# Council Feedback — CLI Implementation (src/cli.ts)

## Sources
- OpenAI (gpt-5.4, reasoning_effort: high)
- Gemini (gemini-3.1-pro-preview)

## Cross-Check Results (Claude)

Before triaging, I verified:
1. Event types in guide match spec schema — ✅ No new event types needed for CLI
2. Lifecycle state machine transitions all legal — ✅ CLI is read-only consumer, no transitions
3. Auto-promotion threshold (>= 0.7) not relevant — CLI doesn't do auto-promotion
4. Token budgeting — not relevant for CLI (only for MCP query_decisions)
5. Stats spec says "source, kind, scope, evidence type, verification status" — guide is MISSING kind and verification_status, has extra state and durability

---

## CRITICAL

### C1: Stats output missing spec-mandated fields (OpenAI + Gemini)
**Issue:** Spec requires grouping by: source, kind, scope, evidence type, verification status. Guide provides: state, evidence_type, scope, durability, source. Missing: decision_kind, verification_status.
**Fix:** Add decision_kind and verification_status groupings. Keep state and durability as bonus sections since they're useful.

### C2: Backfill scope grouping violated (Gemini)
**Issue:** Design spec says backfill "groups commits by scope area" and resume works "by scope area." Guide uses flat chronological order and saves remaining SHAs.
**Fix:** After parsing git log, group commits by derived scope area (top-level directory or config mapping). Process one scope group at a time. Save resume state per scope group.

### C3: Git log pipe delimiter will break on commit messages containing "|" (OpenAI + Gemini)
**Issue:** `git log --format="%H|%s|%ai"` parsed with `split("|")` breaks when commit subject contains `|`.
**Fix:** Use NUL byte delimiter: `--format="%H%x00%s%x00%ai"` and split on `\0`.

### C4: mcp-server.ts argv[1] guard is brittle (OpenAI + Gemini)
**Issue:** `process.argv[1]?.endsWith("mcp-server.js")` fails with symlinks, npx, Windows paths, alternate runtimes.
**Fix:** Remove self-execution from mcp-server.ts entirely. Export `startMcpServer` only. The bin entry `context-ledger-mcp` should be a tiny wrapper that imports and calls `startMcpServer`. This is cleaner than any guard.

### C5: export --format json semantics unclear (OpenAI + Gemini)
**Issue:** Spec says "dump ledger." Guide outputs materialized FoldedDecision array with added fields. These are different things.
**Fix:** Needs human decision — see Design Questions below.

### C6: validate doesn't handle malformed JSONL independently (OpenAI)
**Issue:** `foldLedger` relies on `readLedger` which silently skips malformed lines with console.error. But validate should REPORT malformed lines as validation failures, not silently skip them.
**Fix:** Either: (a) have validate read raw JSONL first with line-by-line checking before folding, or (b) capture malformed line count from readLedger output (currently lost to console.error). Option (a) is correct per spec.

---

## SHOULD FIX

### S1: validate --apply-repair not implemented
**Issue:** Both reviewers note this is a spec command. Guide stubs it.
**Action:** Acceptable for v1 to stub with clear message. Mark as "(not yet implemented)" in --help output.

### S2: Tidy exceeds spec by mutating pending item status (OpenAI)
**Issue:** Guide has tidy expire/ignore pending items based on TTL/times_shown. Spec only says "remove terminal entries older than 30 days."
**Action:** The tidy algorithm in pattern-finder-findings.md section 10 does include this step. This matches the 4-step tidy algorithm derived from the codebase pattern. Keep it.

### S3: --format=value syntax not handled (Gemini)
**Issue:** Manual argv parsing won't handle `--format=json` (equals syntax), only `--format json` (space syntax).
**Fix:** Add simple equals-sign parsing for flag values.

### S4: Missing directory check before commands (OpenAI + Gemini)
**Issue:** Commands other than init should check .context-ledger/ exists and give helpful message.
**Fix:** Add pre-flight check at start of main() for commands that need the ledger directory.

### S5: fs.access() path normalization for affected_files (OpenAI)
**Issue:** affected_files may be repo-relative. Need to resolve against projectRoot.
**Fix:** The guide already uses `resolve(projectRoot, filePath)`. Confirmed correct.

### S6: Backfill creates inbox items without all context (OpenAI)
**Issue:** Git log provides SHA, subject, date. InboxItem also needs changed_files which comes from --name-only. The guide does collect this via `--name-only` flag on git log. Not a real issue.
**Status:** Non-issue — guide already handles this.

### S7: Sub-command help (Gemini)
**Issue:** `context-ledger export --help` should show export-specific usage.
**Fix:** Add command-specific help when --help appears after a command name.

### S8: Dynamic import in backfill handlers (code smell)
**Issue:** Guide uses `await import("./ledger/index.js")` inside loop iterations for backfill. These are already top-level imports.
**Fix:** Use the already-imported `appendToInbox` and `generateInboxId` from top-level imports. Remove dynamic imports.

---

## DESIGN QUESTIONS (for human)

### D1: JSON export: raw events or materialized state?
- Option A: Raw JSONL events (spec says "dump ledger" — implies raw)
- Option B: Materialized FoldedDecision array with state (more useful for analysis)
- Option C: Both — `--format json` for materialized, `--format jsonl` for raw events

### D2: Should mcp-server.ts remain directly executable?
- Option A: Keep as standalone bin entry + export startMcpServer (current plan with guard)
- Option B: Make mcp-server.ts export-only, create tiny bin wrapper (cleanest)

### D3: Stale file references: warning or error?
- Old decisions referencing deleted files may be normal (files were intentionally removed).
- Option A: Warning only (don't contribute to exit code 1)
- Option B: Error (exit 1) — currently in guide

### D4: Multiple active decisions in same scope — is that actually a problem?
- OpenAI asks: "I don't see that invariant in the spec."
- If not an invariant, --propose-repair should call it "review suggestion" not "repair"
- Currently guide labels it as "REVIEW" which seems appropriate.

### D5: Tidy "older than 30 days" — from created date or from status change date?
- Gemini raises: InboxItem has no `status_updated_at` field
- If using `created`, a freshly-dismissed 35-day-old item gets deleted next tidy
- Spec doesn't specify. Current guide uses `created`.

---

## SUGGESTED IMPROVEMENTS (apply at discretion)

### I1: Use NUL-delimited git output for backfill parsing
Already covered by C3 fix.

### I2: Add smoke test list to Phase 7
Add tests for: empty repo, missing .context-ledger, malformed JSONL, commit message with |, CSV on zero decisions, serve without config.

### I3: Remove self-execution from mcp-server.ts
Already covered by C4 fix — create a bin wrapper instead of guarding argv.

### I4: Per-command --help
Add command-specific help text for export, validate, backfill.

### I5: CSV should handle array fields
If any CSV columns contain arrays, join with semicolons. Current CSV columns are all scalars, so this is a non-issue for the specified columns.

### I6: Runtime validation of persisted JSON
Add lightweight type guards when reading backfill-state.json and config.json in CLI.

### I7: Init should not silently modify git hooks
Print what will be modified and let user confirm, or default to printing instructions.
