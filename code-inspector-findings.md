# Code Inspector Findings: context-ledger Setup Wizard Investigation

Generated: 2026-04-01
Scope: Implementation readiness audit for src/setup.ts interactive wizard

---

## 1. Current src/setup.ts

File: C:/Users/russe/documents/context_ledger/src/setup.ts
Status: PLACEHOLDER -- 3 lines only

Lines 1-3: shebang, comment, nothing else. No imports, no functions, no logic.
The context-ledger-setup binary (package.json) maps to dist/setup.js but does nothing.

---

## 2. src/cli.ts -- handleSetup()

File: C:/Users/russe/documents/context_ledger/src/cli.ts

handleSetup() lines 830-834: Hard stub, calls process.exit(1).
Prints two error messages to stderr.

Command dispatch line 78:
    case setup: return handleSetup();

context-ledger-setup binary (dist/setup.js) is a separate entry point with no content.

installPostCommitHook() lines 400-475:
Full hook detection and installation already in cli.ts.
Detection order: .husky/ -> lefthook.yml -> simple-git-hooks -> .git/hooks/
Hook template uses scoped package name @mossrussell/context-ledger.
Marker: string context-ledger (existing.includes(marker))

handleSetup() needs to become:
  import { runSetupWizard } from ./setup.js
  async function handleSetup(): Promise<void> { await runSetupWizard(projectRoot); }

cli.ts existing imports reusable in setup.ts (lines 5-27):
  readFile, mkdir, writeFile, access from node:fs/promises
  join, resolve from node:path
  execSync from node:child_process
  DEFAULT_CONFIG, loadConfig from ./config.js
  ledgerDir, ledgerPath, inboxPath, configPath, appendToLedger,
    readLedger, foldLedger, generateDecisionId from ./ledger/index.js
  searchDecisions from ./retrieval/index.js

setup.ts additionally needs:
  @clack/prompts (no .js -- it is a package)
  readdir from node:fs/promises (Step 2 directory scan)

---

## 3. package.json

File: C:/Users/russe/documents/context_ledger/package.json

name: @mossrussell/context-ledger (line 2)
version: 0.5.4 (line 3)
type: module (line 5) -- ES modules throughout
main: dist/index.js (line 6)

Bin entries lines 7-11:
  context-ledger:       dist/cli.js
  context-ledger-mcp:   dist/mcp-server-bin.js
  context-ledger-setup: dist/setup.js

context-ledger-setup -> dist/setup.js (compiled from src/setup.ts)

Runtime dependencies lines 46-50:
  @clack/prompts:            ^1.2.0  -- ALREADY DECLARED, ready to import
  @modelcontextprotocol/sdk: ^1.29.0
  zod:                       ^4.3.6

Dev dependencies lines 51-57:
  @mossrussell/agent-guard: ^0.6.3
  @types/node:              ^25.5.0
  is-odd:                   ^3.0.1
  rimraf:                   ^6.1.3
  typescript:               ^6.0.2

---

## 4. src/config.ts

File: C:/Users/russe/documents/context_ledger/src/config.ts

LedgerConfig interface lines 15-43:
  capture.enabled: boolean
  capture.ignore_paths: string[]
  capture.scope_mappings: Record<string, ScopeMapping>
  capture.redact_patterns: string[]
  capture.no_capture_marker: string
  capture.inbox_ttl_days: number
  capture.inbox_max_prompts_per_item: number
  capture.inbox_max_items_per_session: number
  retrieval.default_limit: number
  retrieval.include_superseded: boolean
  retrieval.include_unreviewed: boolean
  retrieval.auto_promotion_min_weight: number
  retrieval.token_budget: number
  retrieval.feature_hint_mappings: Record<string, string[]>
  workflow_integration.selective_writeback: boolean
  workflow_integration.check_inbox_on_session_start: boolean
  workflow_integration.jit_backfill: boolean
  monorepo.package_name: string | null
  monorepo.root_relative_path: string | null

ScopeMapping interface lines 10-13:
  export interface ScopeMapping { type: ScopeType; id: string; }

ScopeType (src/ledger/events.ts line 15):
  package | directory | domain | concern | integration

DEFAULT_CONFIG exact values lines 47-75:
  capture.enabled:                     true
  capture.ignore_paths:                [dist/, node_modules/, .next/, coverage/]
  capture.scope_mappings:              {}
  capture.redact_patterns:             []
  capture.no_capture_marker:           [no-capture]
  capture.inbox_ttl_days:              14
  capture.inbox_max_prompts_per_item:  3
  capture.inbox_max_items_per_session: 3
  retrieval.default_limit:             20
  retrieval.include_superseded:        false
  retrieval.include_unreviewed:        false
  retrieval.auto_promotion_min_weight: 0.7
  retrieval.token_budget:              4000
  retrieval.feature_hint_mappings:     {}
  workflow_integration.selective_writeback:          true
  workflow_integration.check_inbox_on_session_start: true
  workflow_integration.jit_backfill:                 true
  monorepo.package_name:               null
  monorepo.root_relative_path:         null

loadConfig() lines 79-90:
  async function loadConfig(projectRoot: string): Promise<LedgerConfig>
  Config path: {projectRoot}/.context-ledger/config.json
  Returns DEFAULT_CONFIG if file is missing (ENOENT).
  Deep-merges file config over defaults; arrays are replaced, not merged.

Config write pattern (cli.ts handleInit() lines 376-380):
  writeFile(cfgPath, JSON.stringify(DEFAULT_CONFIG, null, 2) + newline, utf8)
  Pretty-printed JSON with trailing newline.

---

## 5. src/capture/hook.ts -- Post-Commit Hook

File: C:/Users/russe/documents/context_ledger/src/capture/hook.ts

Exported entry point line 192:
  export async function postCommit(): Promise<void>

Self-invocation guard lines 314-317:
  const isDirectRun = process.argv[1]?.endsWith(hook.js) || ...
  if (isDirectRun) { postCommit().catch(() => {}); }

Hook template and detection logic in cli.ts installPostCommitHook().

Scoped package name @mossrussell/context-ledger appears at:
  cli.ts line 404  hook script template
  cli.ts line 437  Lefthook manual instructions
  cli.ts line 446  simple-git-hooks manual instructions

Hook script template (lines 401-405):
  #!/bin/sh
  # context-ledger post-commit hook
  node -e import(@mossrussell/context-ledger/dist/capture/hook.js)
    .then(m => m.postCommit()).catch(() => {}) 2>/dev/null || true

---

## 6. context-ledger-design-v2.md -- Setup Wizard Section

File: C:/Users/russe/documents/context_ledger/context-ledger-design-v2.md

Setup Wizard definition lines 807-825:

Step 1 -- Project Detection (line 815):
  Reads package.json. Detects tech stack (Next.js, TypeScript, Python, etc.).
  Checks for .claude/ directory, agent-guard, council-mcp registration.
  Shows project summary with checkmarks.

Step 2 -- Scope Mapping Generation (lines 817-818):
  Scans project directory tree.
  Auto-generates scope_mappings and feature_hint_mappings from actual directories.
  Presents suggestions; developer confirms, adjusts, or adds custom mappings.
  Example: I found src/lib/queries/, src/providers/, src/app/api/, and 4 others.

Step 3 -- Hook Installation (lines 819-820):
  Detects Husky / Lefthook / simple-git-hooks / bare .git/hooks/.
  Installs post-commit hook into the correct system.
  If agent-guard pre-commit hook detected, confirms coexistence (different phases).

Step 4 -- Standing Instructions Injection (line 821):
  Detects CLAUDE.md and .cursorrules.
  Injects context-ledger integration snippet.
  If agent-guard standing instructions exist, appends context-ledger block BELOW them.

Step 5 -- First-Run Demo (lines 823-824):
  If backfill done: runs queryDecisions, displays decision pack.
  If no backfill: shows example pack shape, explains when it populates.
  Framing: Here is what Claude Code will know about your project next session.

Standing Instructions Snippet lines 551-576:

Block to inject during Step 4:

  ## context-ledger Integration

  At session start (for non-/auto-feature sessions):
  - Check inbox.jsonl for pending items (max 3 per session). Present Tier 2 first.
  - Note: /auto-feature handles inbox checks automatically.

  Before modifying architectural patterns, adding/removing dependencies,
  creating new directories, or changing established conventions:
  - Use query_decisions with the relevant file path (primary) or scope
  - If trusted precedent exists (retrieval_weight >= 0.7, durability = precedent,
    status = active), follow it and cite the decision ID
  - If no precedent and choice is ambiguous, flag as Bucket 2 question
  - If diverging from precedent, use supersede_decision with rationale and pain_points

  After answering Phase 4 Bucket 2 questions:
  - Classify each answer as precedent, feature-local, or temporary-workaround
  - Use record_writeback for precedent-worthy answers only
  - Temporary workarounds require a review_after date

  For all MCP write tool calls, generate client_operation_id:
  {feature-slug}-{YYYYMMDD}-{random4chars} (e.g., sqo-export-20260401-a3f2).
  Never reuse operation IDs across calls.

Loading order contract line 33:
  Agent-guard docs load first; context-ledger decision packs load second.
  Inject context-ledger block BELOW any existing agent-guard block. Never before.

Guided Backfill Mode lines 827-842:
  After setup completes (optional):
  - Groups structural commits by detected scope area
  - Shows one area at a time with diff summary and draft decision
  - Developer confirms, corrects, or skips
  - Saves progress for context-ledger backfill --resume
  - Running count: 4 decisions captured. 2 areas remaining. Continue?
  - At completion: runs first-run demo

---

## 7. src/ledger/storage.ts -- Path Helpers

File: C:/Users/russe/documents/context_ledger/src/ledger/storage.ts

Path helpers lines 10-24:
  ledgerDir(projectRoot)   -> {root}/.context-ledger
  ledgerPath(projectRoot)  -> {root}/.context-ledger/ledger.jsonl
  inboxPath(projectRoot)   -> {root}/.context-ledger/inbox.jsonl
  configPath(projectRoot)  -> {root}/.context-ledger/config.json

All four exported via src/ledger/index.ts barrel.

Write invariant lines 34-42:
  Every write appends JSON.stringify(item) + newline.
  ensureLedgerDir() called before every write (creates .context-ledger/ if missing).

---

## 8. src/retrieval/ -- queryDecisions and searchDecisions

Files:
  C:/Users/russe/documents/context_ledger/src/retrieval/query.ts
  C:/Users/russe/documents/context_ledger/src/retrieval/packs.ts
  C:/Users/russe/documents/context_ledger/src/retrieval/scope.ts

queryDecisions() lines 36-154 (query.ts):
  async function queryDecisions(params: QueryDecisionsParams, projectRoot: string): Promise<DecisionPack>

  QueryDecisionsParams fields (lines 15-26):
    file_path?:          string   -- primary; server derives scope from this
    query?:              string   -- natural language; triggers broad fallback
    scope_type?:         string   -- overrides file_path derivation
    scope_id?:           string
    decision_kind?:      string   -- soft filter, case-insensitive substring
    tags?:               string[]
    include_superseded?: boolean  -- default false
    include_unreviewed?: boolean  -- default false
    limit?:              number   -- default 20
    offset?:             number   -- default 0

  DecisionPack return shape (packs.ts lines 32-40):
    derived_scope:        DerivedScope | null
    active_precedents:    PackEntry[]  -- each: record, match_reason, retrieval_weight
    abandoned_approaches: AbandonedEntry[]
    recently_superseded:  SupersededEntry[]
    pending_inbox_items:  InboxItem[]
    no_precedent_scopes:  string[]
    token_estimate:       number
    truncated:            boolean

searchDecisions() lines 158-194 (query.ts):
  async function searchDecisions(query: string, projectRoot: string, limit?: number): Promise<SearchResult[]>
  Lexical AND matching across summary, decision, rationale, tags, decision_kind.
  Active-only decisions. Sorted by effective_rank_score descending.
  SearchResult: { record: DecisionRecord; state: LifecycleState; effective_rank_score: number }

For Step 5 first-run demo:
  Call queryDecisions({ query: architecture conventions }, projectRoot)
  Render active_precedents[n].record.summary with .retrieval_weight values.

deriveScope() lines 31-102 (scope.ts):
  function deriveScope(params, config, decisions): DerivedScope | null
  Fallback: explicit -> config_mapping -> scope_alias -> directory_fallback -> feature_hint -> null

---

## 9. Barrel Exports

src/ledger/index.ts:
  Types: EvidenceType, ScopeType, TransitionAction, LifecycleState, Durability,
    VerificationStatus, DecisionSource, InboxStatus, InboxType, LedgerEvent,
    AlternativeConsidered, DecisionScope, DecisionRecord, TransitionEvent, InboxItem,
    FoldedDecision, MaterializedState, FoldOptions, ValidationReport, RepairAction, RepairPlan
  Values: RETRIEVAL_WEIGHTS, generateDecisionId, generateTransitionId, generateInboxId,
    isDecisionRecord, isTransitionEvent, isInboxItem, ledgerDir, ledgerPath, inboxPath,
    configPath, appendToLedger, readLedger, appendToInbox, readInbox, rewriteInbox,
    LedgerIntegrityError, foldEvents, foldLedger, computeEffectiveRankScore, tidyInbox,
    expireStaleItems, getPendingItems, updateInboxItem, validateLedger, proposeRepair
  Key subset for setup.ts:
    generateDecisionId, generateInboxId, appendToLedger, appendToInbox,
    ledgerDir, ledgerPath, inboxPath, configPath, foldLedger, readInbox

src/retrieval/index.ts:
  Re-exports: deriveScope, deriveScopeFromHints, normalizePath, buildDecisionPack,
    queryDecisions, searchDecisions, and all associated types.

src/index.ts -- main package entry (dist/index.js):
  Re-exports everything from config.js, ledger/index.js, retrieval/index.js,
  and { registerReadTools, registerWriteTools } from mcp/index.js.

---

## 10. CLAUDE.md -- Standing Instructions and Loading Order

File: C:/Users/russe/documents/context_ledger/CLAUDE.md

Loading order rule (Ecosystem Integration section):
  Loading order: agent-guard factual docs first, then context-ledger decision packs

Step 4 injection requirements:
  1. Read existing CLAUDE.md or .cursorrules
  2. If agent-guard section exists, append context-ledger block BELOW it
  3. If no agent-guard section, append at end of file
  4. Check for ## context-ledger Integration marker before injecting -- never duplicate
  5. Inject the full snippet from Section 6 above

Detection priority: CLAUDE.md first, then .cursorrules, then inform user.

---

## Summary: Implementation Gaps

| Gap | Status |
|-----|--------|
| src/setup.ts | PLACEHOLDER ONLY -- entire wizard to be written |
| cli.ts handleSetup() | Stub -- needs to import and call wizard from ./setup.js |
| Step 2 directory scan | No utility exists -- needs new fs.readdir logic |
| Step 4 CLAUDE.md injection | Not implemented anywhere in the codebase |
| Step 5 demo renderer | queryDecisions() exists -- needs rendering wrapper only |
| Hook logic sharing | installPostCommitHook() is private in cli.ts -- may need extraction |

---

## File Path Reference

| Role | Absolute Path |
|------|---------------|
| Setup wizard placeholder | C:/Users/russe/documents/context_ledger/src/setup.ts |
| CLI entry point | C:/Users/russe/documents/context_ledger/src/cli.ts |
| Config types and defaults | C:/Users/russe/documents/context_ledger/src/config.ts |
| Hook entry point | C:/Users/russe/documents/context_ledger/src/capture/hook.ts |
| Hook classifier | C:/Users/russe/documents/context_ledger/src/capture/classify.ts |
| Ledger events and types | C:/Users/russe/documents/context_ledger/src/ledger/events.ts |
| Ledger fold | C:/Users/russe/documents/context_ledger/src/ledger/fold.ts |
| Ledger storage helpers | C:/Users/russe/documents/context_ledger/src/ledger/storage.ts |
| Ledger barrel | C:/Users/russe/documents/context_ledger/src/ledger/index.ts |
| Retrieval query | C:/Users/russe/documents/context_ledger/src/retrieval/query.ts |
| Retrieval packs | C:/Users/russe/documents/context_ledger/src/retrieval/packs.ts |
| Retrieval scope | C:/Users/russe/documents/context_ledger/src/retrieval/scope.ts |
| Retrieval barrel | C:/Users/russe/documents/context_ledger/src/retrieval/index.ts |
| Package entry point | C:/Users/russe/documents/context_ledger/src/index.ts |
| Package manifest | C:/Users/russe/documents/context_ledger/package.json |
| Design spec | C:/Users/russe/documents/context_ledger/context-ledger-design-v2.md |
