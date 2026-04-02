# Pattern Finder Findings

Codebase: context-ledger | Date: 2026-04-01
Purpose: Implementation patterns for building src/cli.ts

---
## 1. Full Data Path: Event Creation to JSONL Append to Fold to MCP Query to Response

Entry: MCP write tool handler in src/mcp/write-tools.ts

Step 1. generateDecisionId/generateTransitionId/generateInboxId() -- src/ledger/events.ts
Step 2. Construct DecisionRecord|TransitionEvent with all required fields
        Required: type, id, created (ISO 8601), plus event-specific fields
Step 3. appendToLedger(event, projectRoot) -- src/ledger/storage.ts
        appendFile(path, JSON.stringify(event)+newline, utf8)
        INVARIANT: always trailing newline; NEVER mutate ledger.jsonl
Step 4. readLedger(projectRoot) -- src/ledger/storage.ts
        split on newline, trim, skip empty/malformed. Returns LedgerEvent[]
Step 5. foldEvents(events) / foldLedger(projectRoot) -- src/ledger/fold.ts
        Returns MaterializedState { decisions: Map<id,FoldedDecision>, warnings: string[] }
Step 6. queryDecisions(params, projectRoot) -- src/retrieval/query.ts
        Promise.all([loadConfig, foldLedger])
        deriveScope() produces DerivedScope|null
        Filters FoldedDecision by scope/file/tag/unreviewed rules
        readInbox(), buildDecisionPack() assembles and token-budgets result
Step 7. MCP read tool (src/mcp/read-tools.ts) wraps pack as JSON text content
        On error: { content:[...], isError:true }

Key files:
- src/ledger/events.ts       -- types, ID generators, type guards
- src/ledger/storage.ts      -- JSONL I/O (appendToLedger, readLedger, appendToInbox, readInbox, rewriteInbox)
- src/ledger/fold.ts         -- foldEvents, foldLedger, LedgerIntegrityError
- src/retrieval/query.ts     -- queryDecisions, searchDecisions
- src/retrieval/scope.ts     -- deriveScope, normalizePath
- src/retrieval/packs.ts     -- buildDecisionPack, DecisionPack type
- src/mcp/read-tools.ts      -- registerReadTools (query_decisions)
- src/mcp/write-tools.ts     -- registerWriteTools (5 write tools)

---
## 2. MCP Tool to Library Call Map

read-tools: query_decisions
  queryDecisions(args, projectRoot): Promise<DecisionPack>
  (from src/retrieval/index.ts)

write-tools: propose_decision
  readInbox(projectRoot)  -- idempotency check
  generateInboxId()
  appendToInbox(item, projectRoot)

write-tools: confirm_pending
  readLedger(projectRoot)  -- idempotency check
  readInbox(projectRoot)
  generateDecisionId()
  appendToLedger(record, projectRoot)
  rewriteInbox(updatedItems, projectRoot)

write-tools: reject_pending
  readInbox(projectRoot)
  rewriteInbox(updatedItems, projectRoot)

write-tools: supersede_decision
  readLedger(projectRoot)  -- idempotency check
  foldLedger(projectRoot)  -- lifecycle validation
  generateTransitionId()
  appendToLedger(event, projectRoot)

write-tools: record_writeback
  readLedger(projectRoot)  -- idempotency check
  foldLedger(projectRoot)  -- conflict detection
  generateDecisionId()
  appendToLedger(record, projectRoot)

Return types:
- queryDecisions -> DecisionPack (src/retrieval/packs.ts)
- foldLedger -> MaterializedState { decisions: Map<string,FoldedDecision>, warnings: string[] }
- write tools -> makeToolResult(data) | makeToolError(message)

---
## 3. Config Resolution: DEFAULT_CONFIG to File to Runtime

loadConfig(projectRoot: string): Promise<LedgerConfig> in src/config.ts
  - filePath = join(projectRoot, .context-ledger, config.json)
  - ENOENT: return DEFAULT_CONFIG (all defaults)
  - Other readFile error: throw
  - Success: deepMerge(DEFAULT_CONFIG, JSON.parse(raw))
    deepMerge is recursive for nested objects; arrays and null override entire defaults

projectRoot = process.env.CONTEXT_LEDGER_PROJECT_ROOT ?? process.cwd()
Established in src/mcp-server.ts line 9. CLI must use identical pattern.
No CLI argument overrides exist in current codebase.

DEFAULT_CONFIG values (src/config.ts):
  capture.inbox_ttl_days: 14
  capture.inbox_max_prompts_per_item: 3
  capture.inbox_max_items_per_session: 3
  retrieval.default_limit: 20
  retrieval.token_budget: 4000
  retrieval.auto_promotion_min_weight: 0.7
  retrieval.include_superseded: false
  retrieval.include_unreviewed: false

---
## 4. Error Handling Patterns

LedgerIntegrityError (src/ledger/fold.ts):
  export class LedgerIntegrityError extends Error
  Thrown only when: foldEvents(events, { strict: true })
  Default (strict:false): push violation message to state.warnings[], continue
  Detection: err instanceof LedgerIntegrityError
  Usage example: test4_strictModeThrows in src/ledger/smoke-test.ts

MCP write tools (src/mcp/write-tools.ts) -- two module-level helpers:
  makeToolResult(data) -> { content:[{ type:text, text:JSON.stringify(data,null,2) }] }
  makeToolError(message) -> console.error log + { content:[...], isError:true }
  Every handler: try { return makeToolResult(data); } catch(err) { return makeToolError(err.message); }

MCP read tools (src/mcp/read-tools.ts):
  Inline: catch(err) { return { content:[...], isError:true }; }
  Does NOT call console.error (inconsistency vs write-tools -- see section 17)

Storage (src/ledger/storage.ts):
  ENOENT on readLedger/readInbox: return [] (never throw on missing file)
  Malformed JSONL lines: console.error warning, skip line, continue (never throw)
  Other errors: propagate

CLI (from CLAUDE.md):
  diagnostics: console.error (stderr)
  command output: stdout
  failure: process.exit(1)

---
## 5. JSONL I/O Patterns (src/ledger/storage.ts)

Path helpers (all take projectRoot: string):
  ledgerDir  = join(projectRoot, .context-ledger)
  ledgerPath = join(ledgerDir, ledger.jsonl)
  inboxPath  = join(ledgerDir, inbox.jsonl)
  configPath = join(ledgerDir, config.json)

appendToLedger / appendToInbox (append-only):
  ensureLedgerDir(projectRoot)  // mkdir({ recursive:true }) -- idempotent
  appendFile(path, JSON.stringify(event) + newline, utf8)
  INVARIANT: always trailing newline; NEVER rewrite ledger.jsonl

readLedger / readInbox:
  ENOENT: return []
  split on newline, trim each line, skip empty
  malformed JSON: console.error warning, skip line, continue
  returns typed array: LedgerEvent[] or InboxItem[]

rewriteInbox (ONLY for tidy + status updates -- NEVER on ledger.jsonl):
  tmpPath = inboxPath + .tmp
  writeFile(tmpPath, items.map(JSON.stringify).join(newline)+newline, utf8)
  rename(tmpPath, inboxPath)  // atomic swap
  This is the ONLY function that mutates any JSONL file

---
## 6. foldLedger Return Shape

MaterializedState (src/ledger/fold.ts):
  decisions: Map<string, FoldedDecision>  // keyed by decision ID
  warnings: string[]                       // violations in lenient mode

FoldedDecision (src/ledger/fold.ts):
  record: DecisionRecord        // original event as written to ledger
  state: active|superseded|abandoned|expired
  replaced_by: string|null      // set when state===superseded
  reinforcement_count: number   // count of reinforce transitions applied
  effective_rank_score: number  // base weight + reinforce bonus, capped at 1.0
  transitions: TransitionEvent[]  // full audit trail of all transitions

Fold rules:
  - Events in log-append order (array order from readLedger)
  - Decision records: inserted as state=active, score=RETRIEVAL_WEIGHTS[evidence_type]
  - Transitions: applyTransition() mutates Map entry for target_id
  - Feature-local auto-expiry: post-pass, 60-day TTL from created (or last reopen)
  - strict:false: push violations to warnings[], continue
  - strict:true: throw LedgerIntegrityError on first violation
  - Idempotent duplicates: added to transitions[] audit trail, no state change

computeEffectiveRankScore:
  Math.min(1.0, baseWeight + Math.min(0.15, 0.05 * reinforcementCount))
  baseWeight = RETRIEVAL_WEIGHTS[evidence_type]; max bonus = +0.15

RETRIEVAL_WEIGHTS (src/ledger/events.ts):
  human_answered:1.0, explicit_manual:1.0, workflow_writeback:0.9
  corrected_draft:0.85, confirmed_draft:0.8, backfill_confirmed:0.7
  commit_inferred:0.2  (NOT auto-promotion eligible -- context only)

---
## 7. queryDecisions vs searchDecisions (src/retrieval/query.ts)

queryDecisions(params: QueryDecisionsParams, projectRoot: string): Promise<DecisionPack>
  QueryDecisionsParams: {
    file_path?, query?, scope_type?, scope_id?, decision_kind?, tags?,
    include_superseded?, include_unreviewed?, limit?, offset?
  }
  - Promise.all([loadConfig, foldLedger]) -- parallel execution
  - deriveScope() produces DerivedScope|null
  - Filter by: unreviewed exclusion, feature-local exclusion, decision_kind substring
  - Assign match_reason: scope_hit | file_path_hit | tag_match | broad_fallback
  - Inbox: pending only, question_needed first, recency tiebreak, limit to 3
  - Returns DecisionPack (primary MCP retrieval contract)
  - Used by: query_decisions MCP tool, CLI query command

searchDecisions(query: string, projectRoot: string, limit?: number): Promise<SearchResult[]>
  type SearchResult = { record: DecisionRecord; state: LifecycleState; effective_rank_score: number }
  - foldLedger(projectRoot) only (no config)
  - ALL tokens must match (AND, case-insensitive) in summary+decision+rationale+tags+kind
  - Active only; sort by score desc; default limit 20
  - No scope derivation, no inbox, no token budgeting, no feature-local exclusion
  - Used by: CLI debugging/search (not exposed via MCP)

Key difference:
  queryDecisions: scope-aware, policy-filtered, token-budgeted, inbox-aware -> DecisionPack
  searchDecisions: lexical, minimal, active-only -> SearchResult[]

---
## 8. Scope Derivation (src/retrieval/scope.ts)

deriveScope(params, config, decisions): DerivedScope | null
Fallback order (stops at first match):

1. Explicit: params.scope_type AND params.scope_id both present
   returns { type, id, source:explicit }

2. Config mapping: params.file_path present
   normalizePath(file_path); longest-prefix match against config.capture.scope_mappings keys
   keys sorted by length descending (longest match wins)
   returns { type:mapping.type, id:mapping.id, source:config_mapping }

3. Scope alias: params.file_path; no config mapping matched
   search active FoldedDecision.record.scope_aliases[] for prefix match
   returns { type:scope.type, id:scope.id, source:scope_alias }

4. Directory fallback: params.file_path; no mapping/alias matched
   segments = normalizePath(file_path).split(/)
   find src/ segment; use segment[srcIndex+1] as id, type:directory
   no src/ segment: use segments[0] as id
   returns { type:directory, id:scopeId, source:directory_fallback }

5. Feature hint: params.query; no file_path resolved
   deriveScopeFromHints(query, config.retrieval.feature_hint_mappings)
   tokenize on non-word chars; match against hint keywords
   returns { type:domain, id:matched[0], source:feature_hint }

6. Recency fallback: return null
   Caller: include all active precedents, sort by created desc

normalizePath(p): backslash->/, strip leading ./, lowercase
DerivedScope: { type: ScopeType, id: string, source: ScopeSource }
ScopeType: package|directory|domain|concern|integration
ScopeSource: explicit|config_mapping|scope_alias|directory_fallback|feature_hint|recency_fallback

---
## 9. Decision Pack Assembly (src/retrieval/packs.ts)

buildDecisionPack(decisions, scope, inboxItems, params, config): DecisionPack
Input: pre-filtered Array<FoldedDecision & { match_reason: MatchReason }>

1. Classify into buckets:
   state===active    -> active_precedents (PackEntry)
                        review_overdue=true if durability=temporary-workaround AND review_after < now
   state===abandoned -> abandoned_approaches (AbandonedEntry)
                        pain_points from last abandon transition in folded.transitions[]
   state===superseded AND include_superseded AND last supersede < 90 days
                     -> recently_superseded (SupersededEntry)

2. Sort: active by effective_rank_score desc; abandoned/superseded by created desc

3. Paginate: active_precedents.slice(offset, offset+limit)
   default limit = config.retrieval.default_limit (20)

4. no_precedent_scopes: if scope set and paginatedActive.length === 0, push scope.id

5. Token budget: estimate = Math.ceil(JSON.stringify(pack).length / 4)
   budget = config.retrieval.token_budget (default 4000)
   if over budget (truncated=true):
     a. drop all recently_superseded
     b. drop all abandoned_approaches
     c. pop active_precedents from tail one at a time
   logs to console.error when trimming

DecisionPack shape:
  { derived_scope: DerivedScope|null,
    active_precedents: PackEntry[],         // { record, match_reason, retrieval_weight, review_overdue? }
    abandoned_approaches: AbandonedEntry[], // { record, match_reason, pain_points: string[] }
    recently_superseded: SupersededEntry[], // { record, match_reason, replaced_by: string }
    pending_inbox_items: InboxItem[],
    no_precedent_scopes: string[],
    token_estimate: number,
    truncated: boolean }

MatchReason: scope_hit | file_path_hit | tag_match | broad_fallback

---
## 10. Inbox Item Management

InboxItem fields (src/ledger/events.ts):
  inbox_id(q_{unix}_{hex2}), type(draft_needed|question_needed), created (ISO 8601),
  commit_sha, commit_message, change_category, changed_files[], diff_summary,
  priority(always normal), expires_after (ISO 8601), times_shown, last_prompted_at,
  status(pending|confirmed|corrected|dismissed|expired|ignored)

Creation (propose_decision in src/mcp/write-tools.ts):
  generateInboxId() for inbox_id; expires_after = now + 14 days
  status=pending, times_shown=0, last_prompted_at=null
  Extended via PersistedInboxItem (extra fields stored in inbox.jsonl):
    client_operation_id: string
    proposed_record: ProposedRecord (all fields needed for DecisionRecord on confirm)
  appendToInbox(item, projectRoot)

Status transitions:
  pending -> confirmed  (confirm_pending: appends DecisionRecord to ledger.jsonl)
  pending -> dismissed  (reject_pending)
  pending -> expired    (tidy: expires_after < now)
  pending -> ignored    (tidy: times_shown >= inbox_max_prompts_per_item)
  Terminal: confirmed|dismissed|expired|ignored (never surfaced again, kept for audit)

Retrieval priority in queryDecisions:
  filter: status===pending
  sort: question_needed first; recency tiebreaker (newest first)
  limit: config.capture.inbox_max_items_per_session (default 3)

Idempotency:
  propose_decision: readInbox() check for matching client_operation_id
  confirm_pending:  readLedger() check for matching client_operation_id

tidy algorithm:
  1. readInbox(projectRoot)
  2. pending: expired if expires_after<now; ignored if times_shown>=max_prompts
  3. filter out: terminal items with created older than 30 days
  4. rewriteInbox(filtered, projectRoot)
  output: count removed to stdout

---
## 11. CLI Command Specifications (from context-ledger-design-v2.md)

Binary: package.json bin[context-ledger] = dist/cli.js
        src/cli.ts compiled by tsc to dist/cli.js
Must NOT use @clack/prompts (reserved for src/setup.ts only)
Uses Node built-ins only for runtime (zero additional runtime deps)
projectRoot = process.env.CONTEXT_LEDGER_PROJECT_ROOT ?? process.cwd()

context-ledger init
  Create .context-ledger/ directory
  Write config.json from DEFAULT_CONFIG
  Install post-commit hook (detect Husky/Lefthook/bare .git/hooks)
  Diagnostics to stderr; success message to stdout

context-ledger serve
  Start MCP server over stdio
  stdout RESERVED for JSON-RPC; all diagnostics via console.error only

context-ledger query <query>
  Primary: searchDecisions(query, projectRoot, limit?) -- lexical, active only
  Alt: queryDecisions(params, projectRoot) -- scope-aware, full DecisionPack
  Results to stdout in human-readable format

context-ledger stats
  foldLedger(projectRoot); group state.decisions.values() by:
  source, decision_kind, scope.id, evidence_type, verification_status
  Counts to stdout

context-ledger export --format json|csv
  json: JSON.stringify of events or materialized state
  csv: with header row
  Output to stdout

context-ledger validate
  foldLedger(projectRoot, { strict:false }) -- collect all warnings
  readInbox(projectRoot) -- structural integrity check
  fs.access() on each record.affected_files -- stale ref detection
  Output violations to stdout; exit code 1 if any found
  Does NOT auto-repair (design spec: validate checks invariants and reports)

context-ledger validate --propose-repair
  Read-only; repair plan to stdout
  Includes: deduplication, contradictory active decisions in same scope,
            scope alias updates from git rename history

context-ledger validate --apply-repair
  Apply reviewed repair plan with explicit opt-in
  Input source: TBD (see section 17)
  Uses rewriteInbox() where needed

context-ledger tidy
  Compact inbox.jsonl; remove terminal entries older than 30 days
  Uses rewriteInbox() -- only sanctioned mutation of inbox.jsonl
  Algorithm: section 10. Output count removed to stdout.

context-ledger backfill --max 5
  Batch backfill, default cap 5 commits per session
  Read git log; classify structural commits; surface draft; confirm/correct/skip
  Write via appendToLedger (no MCP round-trip needed)
  --resume: resume interrupted session (state location TBD)
  --max N: override per-session cap

context-ledger setup
  Delegates to src/setup.ts (interactive wizard with @clack/prompts)
  CLI entry imports or spawns setup

---
## 12. MCP Tool Registration Pattern

Exact signature used by every tool in src/mcp/read-tools.ts and src/mcp/write-tools.ts:

  server.tool(
    tool_name,             // snake_case string
    description,           // human-readable string
    { zod schema },        // z.type().optional().describe(hint)
    { readOnlyHint, destructiveHint, openWorldHint: false },  // ALL 3 required
    async (args) => {      // always async
      try { return makeToolResult(data); }
      catch (err: any) { return makeToolError(err.message); }
    }
  );

Annotations matrix:
  query_decisions:    { readOnlyHint:true,  destructiveHint:false, openWorldHint:false }
  propose_decision:   { readOnlyHint:false, destructiveHint:false, openWorldHint:false }
  confirm_pending:    { readOnlyHint:false, destructiveHint:false, openWorldHint:false }
  reject_pending:     { readOnlyHint:false, destructiveHint:false, openWorldHint:false }
  supersede_decision: { readOnlyHint:false, destructiveHint:true,  openWorldHint:false }
  record_writeback:   { readOnlyHint:false, destructiveHint:false, openWorldHint:false }
  openWorldHint:false on ALL tools (local filesystem only, no external calls)

Idempotency check pattern (all write tools):
  const existing = await readInbox/readLedger(projectRoot);
  const dup = existing.find(e => e.client_operation_id === args.client_operation_id);
  if (dup) return makeToolResult({ status: already_processed, ... });

---
## 13. Module Boundary Rules

src/ledger/       -- data model only; no imports from retrieval/ or mcp/
src/retrieval/    -- query logic; imports from ledger/ and config.ts only
src/mcp/          -- tool registration; imports from ledger/ and retrieval/
src/config.ts     -- imports ScopeType from ledger/index.ts only
src/cli.ts        -- may import from all modules (top-level consumer)
src/mcp-server.ts -- imports from mcp/ only

---
## 14. Import Style Rules

All imports use .js extensions (Node16 module resolution):
  import { foldLedger } from ../ledger/index.js;
  import { loadConfig } from ../config.js;
  import { queryDecisions } from ../retrieval/index.js;

tsconfig.json: module:Node16, moduleResolution:Node16, target:ES2022
package.json: type:module (ES modules throughout, no require())

---
## 15. ID Format Summary (src/ledger/events.ts)

Decision:   d_{unix}_{hex4}  e.g. d_1711900800_a3f2
            unix=Math.floor(Date.now()/1000)
            hex4=Math.floor(Math.random()*0xffff).toString(16).padStart(4,0)

Transition: t_{unix}_{hex4}  (same format as decision ID)

Inbox:      q_{unix}_{hex2}  e.g. q_1711900800_f3
            hex2=Math.floor(Math.random()*0xff).toString(16).padStart(2,0)

---
## 16. Stdout / Stderr Rules

serve mode (src/mcp-server.ts):
  stdout: RESERVED for MCP JSON-RPC -- no other writes allowed
  stderr (console.error): startup confirmation, diagnostics, errors

CLI non-serve commands (src/cli.ts):
  stdout: command output (results, stats, export, success messages)
  stderr (console.error): diagnostics, warnings, error details
  process.exit(1) on failure

src/ledger/storage.ts: malformed JSONL lines -> console.error (correct for both modes)
src/retrieval/packs.ts: token budget trim -> console.error (correct for both modes)

---
## 17. Inconsistencies and Gaps Flagged

1. Error helper inconsistency:
   src/mcp/read-tools.ts (line 30): inline error response, no console.error logging.
   src/mcp/write-tools.ts: makeToolError() helper includes console.error logging.
   CLI code should adopt the makeToolError pattern consistently.

2. src/ledger/validate.ts is a stub (Implementation pending):
   Validate CLI must implement integrity checks directly:
   - orphaned targets + lifecycle violations: available via foldLedger warnings (strict:false)
   - stale file refs: fs.access() on each record.affected_files path

3. src/ledger/inbox.ts is a stub (Implementation pending):
   Tidy TTL expiry and times_shown tracking must be implemented in cli.ts directly for now.

4. src/capture/ (index.ts, hook.ts, classify.ts) are all stubs:
   CLI init must implement hook detection and installation directly.

5. src/setup.ts is a stub:
   Setup command has nothing to delegate to. Implement first or skip in v1 CLI.

6. rewriteInbox edge case:
   Empty items array -> items.map(...).join(newline)+newline writes a bare newline.
   Safe because readInbox skips empty lines, but slightly inconsistent.

7. backfill --resume state storage: not specified in design spec.
   Expected location: .context-ledger/backfill-state.json
   Decision needed before implementing --resume flag.

8. validate --apply-repair input source: not specified in design spec.
   Choose: stdin, .context-ledger/repair-plan.json, or file path argument.
   Decision needed before implementing --apply-repair.
