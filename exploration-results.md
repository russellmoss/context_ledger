# Exploration Results — CLI Implementation (src/cli.ts)

Date: 2026-04-01
Sources: code-inspector-findings.md, pattern-finder-findings.md

---

## Pre-Flight Summary

The CLI stub exists at src/cli.ts (3 lines, shebang + comments). package.json already maps `context-ledger` bin to `dist/cli.js`. All core modules (ledger, retrieval, config) are fully implemented and exported through barrel files. Six stub files block full implementations of some commands: `validate.ts`, `inbox.ts`, `capture/index.ts`, `capture/classify.ts`, `capture/hook.ts`, and `setup.ts`. However, the CLI can achieve minimum viability for all 10 commands by calling existing functions directly and implementing lightweight logic inline where stubs exist. The `serve` command needs special handling since `mcp-server.ts` exports nothing — recommend inlining the 3-line McpServer setup using already-exported `registerReadTools`/`registerWriteTools`. Two design decisions are unresolved: backfill `--resume` state storage location and `validate --apply-repair` input source.

---

## Files to Modify

| File | Changes |
|------|---------|
| `src/cli.ts` | **Primary target.** Replace 3-line stub with full CLI (~400-600 lines). 10 commands, --help, --version. |
| `src/mcp-server.ts` | Extract `startMcpServer(projectRoot)` function and export it, OR have CLI inline the setup. |

### Files to Read (no modifications needed)

| File | Used By Commands |
|------|-----------------|
| `src/config.ts` | init (DEFAULT_CONFIG), all commands (loadConfig, projectRoot pattern) |
| `src/ledger/index.ts` | All commands — barrel for types, storage, fold |
| `src/ledger/events.ts` | stats (RETRIEVAL_WEIGHTS), type guards |
| `src/ledger/storage.ts` | init (ledgerDir, configPath), tidy (readInbox, rewriteInbox), export (readLedger) |
| `src/ledger/fold.ts` | stats, export, validate (foldLedger, LedgerIntegrityError) |
| `src/retrieval/index.ts` | query (searchDecisions), barrel for types |
| `src/retrieval/query.ts` | query (searchDecisions signature) |
| `src/mcp/index.ts` | serve (registerReadTools, registerWriteTools) |
| `package.json` | --version (version field) |

---

## Type Changes

**No type changes required.** All types needed by the CLI already exist and are exported:

- `DecisionRecord`, `TransitionEvent`, `InboxItem`, `LedgerEvent` — from `src/ledger/events.ts`
- `FoldedDecision`, `MaterializedState`, `FoldOptions`, `LedgerIntegrityError` — from `src/ledger/fold.ts`
- `LedgerConfig` — from `src/config.ts`
- `DecisionPack`, `SearchResult`, `QueryDecisionsParams` — from `src/retrieval/query.ts`
- `LifecycleState`, `EvidenceType`, `Durability`, `InboxStatus` — string unions from `src/ledger/events.ts`

---

## Construction Site Inventory

The CLI does not construct DecisionRecord, TransitionEvent, or InboxItem objects directly. It is a read-oriented consumer that calls existing functions:

| CLI Command | Functions Called | Return Type |
|-------------|----------------|-------------|
| init | `mkdir`, `writeFile` (node:fs/promises), `DEFAULT_CONFIG` | void |
| serve | `McpServer`, `registerReadTools`, `registerWriteTools`, `StdioServerTransport` | void (long-running) |
| query | `searchDecisions(query, projectRoot)` | `SearchResult[]` |
| stats | `foldLedger(projectRoot)`, `readInbox(projectRoot)` | `MaterializedState`, `InboxItem[]` |
| export | `foldLedger(projectRoot)` | `MaterializedState` |
| validate | `foldLedger(projectRoot, { strict: false })`, `readInbox(projectRoot)`, `fs.access()` | `MaterializedState` |
| validate --propose-repair | Same as validate + analysis logic | void |
| tidy | `readInbox(projectRoot)`, `rewriteInbox(filtered, projectRoot)` | void |
| backfill | `execSync('git log ...')`, `appendToLedger(record, projectRoot)` | void |
| setup | Delegate to `src/setup.ts` (stub) | void |

---

## Recommended Phase Order

### Phase 1: Core CLI Framework
- argv parsing, --help, --version, projectRoot resolution, error handling wrapper
- Commands: serve (simplest — just start MCP server)

### Phase 2: Read Commands
- query, stats, export
- These only read data and format output. No mutations.

### Phase 3: Validation Commands
- validate, validate --propose-repair
- Read-only but need additional fs.access() checks and analysis logic.

### Phase 4: Write Commands
- init, tidy
- These create/modify files on disk.

### Phase 5: Backfill Commands
- backfill --max N, backfill --resume
- Most complex: git log parsing, commit classification, state persistence.

### Phase 6: Setup Delegation
- setup command (delegates to src/setup.ts which is a stub)
- Minimal: just print "setup not yet implemented" or dynamic import.

---

## Risks and Blockers

### Blocking Issues
1. **mcp-server.ts exports nothing** — serve command can't `import { start }`. Fix: either export a `startMcpServer` function or inline the 3-line setup in cli.ts.
2. **capture/ stubs** — backfill commit classification logic doesn't exist. CLI must implement lightweight classification inline or defer backfill.
3. **validate.ts stub** — No dedicated validation module. CLI can use `foldLedger({ strict: false })` warnings + fs.access() checks as minimum viability.

### Design Decisions Needed
4. **backfill --resume state location** — Not specified in design spec. Recommend `.context-ledger/backfill-state.json`.
5. **validate --apply-repair input source** — Not specified. Recommend reading from stdin (pipe `--propose-repair` output).

### Edge Cases
6. **Empty ledger** — All read commands must handle zero decisions gracefully.
7. **Missing .context-ledger/ directory** — Commands other than init should fail with helpful message.
8. **Malformed JSONL** — Storage layer already handles this (skip + warn), but validate should report it.
9. **rewriteInbox with empty array** — Writes bare newline. Safe but slightly odd.

---

## Design Spec Compliance

Checked against context-ledger-design-v2.md:

| Spec Requirement | Status |
|-----------------|--------|
| CLI commands list (§ CLI Commands) | ✅ All 10 commands + setup covered |
| init creates .context-ledger/ + config.json + hook | ✅ Matches spec |
| serve starts MCP over stdio | ✅ Matches spec |
| query uses searchDecisions for CLI debugging | ✅ Spec says "CLI/debugging only, lexical fallback" |
| stats groups by source, kind, scope, evidence type | ✅ Matches spec |
| export supports json and csv formats | ✅ Matches spec |
| validate checks invariants, does not auto-repair | ✅ Matches spec |
| validate --propose-repair outputs plan, no modification | ✅ Matches spec |
| validate --apply-repair applies reviewed plan | ⚠️ Input source unspecified in spec |
| tidy removes terminal entries > 30 days | ✅ Matches spec |
| backfill --max N default cap 5 | ✅ Matches spec |
| backfill --resume state persistence | ⚠️ State location unspecified in spec |
| No console.log in serve mode (stdout = JSON-RPC) | ✅ Will use console.error for diagnostics |
| .js extensions on all imports | ✅ Required by Node16 resolution |
| Zero additional runtime dependencies | ✅ Node built-ins only for CLI |
