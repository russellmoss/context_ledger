# v1.2.1 Code Inspector Findings

## 1. Type/Interface Changes Needed

### 1a. src/config.ts

DrafterCaptureConfig (lines 15-20) needs one new field for Bug 9:
  revert_suppression_window_hours?: number   // default 24

New interface to add after DrafterCaptureConfig (after line 20):
  export interface ClassifierCaptureConfig {
    editor_backup_patterns: string[];
  }

LedgerConfig.capture (lines 22-33) gains:
  classifier: ClassifierCaptureConfig;

DEFAULT_CONFIG (lines 55-84) must be extended:
  drafter block: add revert_suppression_window_hours: 24
  new classifier key: { editor_backup_patterns: ["*.bak","*.orig","*.swp","*.swo","*~",".#*"] }

deepMerge in src/config.ts (lines 107-122) is recursive. Arrays are replaced wholesale (line 113
isArray short-circuit), matching ignore_paths behavior. SAFE for both new fields.

### 1b. src/ledger/events.ts

ProposedDecisionDraft (lines 78-87) is missing scope fields from the MCP ProposedRecord type.
Add optional fields for backward compat with existing inbox.jsonl lines:
  scope_type?: string;
  scope_id?: string;
  affected_files?: string[];
  scope_aliases?: string[];
  revisit_conditions?: string;
  review_after?: string | null;

InboxItem (line 102) currently has:
  proposed_decision?: ProposedDecisionDraft;

Canonical key becomes proposed_record. Old key kept as backward-compat read alias:
  proposed_record?: ProposedDecisionDraft;
  proposed_decision?: ProposedDecisionDraft;  // backward-compat alias; readers check both

No migration of existing JSONL lines needed.
## 2. Construction Sites

### Writers (set the draft key on an InboxItem)

src/capture/hook.ts:59:
  if (proposedDecision) item.proposed_decision = proposedDecision;
  MUST change to: item.proposed_record = proposedDecision;
  AND proposedDecision must be enriched with scope_type, scope_id, affected_files,
  scope_aliases before assignment (Bug 8 -- see section 5).

src/mcp/write-tools.ts:130 (lines 128-147):
  persisted.proposed_record = { ... };
  Already canonical. No key change needed.

### Readers (consume the draft key from an InboxItem)

src/mcp/write-tools.ts:186:
  const proposed = item.proposed_record;
  Already reads proposed_record. After fix must also fall back for backward compat:
  const proposed = item.proposed_record ?? (item as any).proposed_decision;

src/retrieval/packs.ts -- buildDecisionPack surfaces raw InboxItem objects.
  Does not read draft fields. No change needed.

src/cli.ts handleQuery() (lines 210-216) reads only i.type, i.inbox_id, i.commit_sha,
  i.change_category, i.commit_message. No draft field access. No change needed.

src/capture/hook.test.ts Tests 5 and 6 assert on draftNeeded.proposed_decision
  at lines 160,161,163,165,166,167,170,171,207,208.
  All must be updated to proposed_record. Add assertions for scope fields.

src/mcp/smoke-test.ts:120 -- already casts to proposed_record. No change needed.

### proposed_decision / proposed_record grep summary (src/)

proposed_decision occurrences:
  src/capture/hook.ts:59 -- WRITE SITE (change to proposed_record)
  src/capture/hook.ts:2 -- comment only
  src/ledger/events.ts:102 -- field declaration (becomes backward-compat alias)
  src/mcp/write-tools.ts:408 -- inside record_writeback conflict response body JSON
    (JSON response payload key, not InboxItem storage field -- leave as-is)
  src/capture/hook.test.ts:4,140,143,160,161,163,165,166,167,170,171,183,186,207,208 -- test assertions
  src/capture/drafter.ts:2 -- comment only

proposed_record occurrences:
  src/mcp/write-tools.ts:52,130,186 -- canonical key, already correct
  src/mcp/smoke-test.ts:120 -- already correct
## 3. deriveScope Callers Audit

Signature (src/retrieval/scope.ts lines 31-35):
  export function deriveScope(
    params: { file_path?: string; query?: string; scope_type?: string; scope_id?: string },
    config: LedgerConfig,
    decisions: Map<string, FoldedDecision>,
  ): DerivedScope | null

All callers in src/:

  src/capture/hook.ts:318 -- Tier 2 contradiction check
    deriveScope({ file_path: f }, config, foldedState.decisions)

  src/capture/hook.ts:372-374 -- Drafter scope lookup
    deriveScope({ file_path: result.changed_files[0] }, config, foldedState?.decisions ?? new Map())

  src/retrieval/query.ts:107-111 -- Query orchestrator
    deriveScope({ file_path, query, scope_type, scope_id }, config, state.decisions)

The drafter scope lookup (hook.ts:372) ALREADY calls deriveScope with changed_files[0].
For Bug 8: take the returned DerivedScope and copy type/id into ProposedDecisionDraft
fields, plus copy result.changed_files into affected_files.
NO signature change to deriveScope is required.

## 4. Classify File-Deletion Logic (Bug 10)

File: src/capture/classify.ts

Function signature (lines 162-169) receives three separate arrays:
  classifyCommit(changedFiles, deletedFiles, addedFiles, commitMessage, config, packageJsonDiff?)

File-deletion classifier at lines 313-322:
  const unclaimed = del.filter((f) => !claimedFiles.has(f) && !isTestFile(f) && !isDocFile(f));
  if (unclaimed.length > 0) {
    results.push({ tier:1, change_category:"file-deletion", inbox_type:"draft_needed",
      changed_files: dedup(unclaimed) });
  }

del is ignore_paths-filtered (line 181). unclaimed = deleted files not yet claimed by Tier 2.

Fix insertion point: between computing unclaimed (line 314) and the if-push block.

Pattern matching strategy (zero deps, pure function on base filename):
  *.bak *.orig *.swp *.swo -> base.endsWith(".bak") etc.
  *~                       -> base.endsWith("~")
  .#*                      -> base.startsWith(".#")

Logic to insert after computing unclaimed:
  const backupPatterns = config.capture.classifier?.editor_backup_patterns ?? [];
  if (backupPatterns.length > 0 && unclaimed.length > 0) {
    const nonBackup = unclaimed.filter(f => !matchesEditorBackupPattern(f, backupPatterns));
    if (nonBackup.length === 0) { /* suppress entirely */ }
    else if (nonBackup.length < unclaimed.length) {
      results.push({ tier:1, change_category:"file-deletion", inbox_type:"draft_needed",
        changed_files: dedup(nonBackup) });  // mixed: fire on real deletions only
    } // else: all real deletions, fall through to original push
  }

Optional chain on config.capture.classifier is safe; DEFAULT_CONFIG fills it at load time.
## 5. Hook/Drafter Flow for Bug 9 (Revert Suppression)

File: src/capture/hook.ts

Current SHA at line 253:
  const sha = execSync("git rev-parse HEAD", ...).trim();
Subject at line 254:
  const subject = execSync("git log -1 --format=%s HEAD", ...).trim();

New function: isRevertSuppressed(projectRoot, sha, subject, config): boolean
Called after line 265 (isMergeCommit check) and before line 272 (git diff-tree).
This exits before any ledger I/O or file classification.

The git log shellout inside isRevertSuppressed:
  execFileSync("git", ["log", "--format=%H%x00%s%x00%ct", "-n", "20"],
    { cwd: projectRoot, encoding: "utf8", timeout: 50, stdio: ["ignore","pipe","pipe"] })

Parse into {hash, subject, unixTs}. Suppression logic:
  1. Current subject starts with "Revert" AND references another SHA from the log within
     windowHours: suppress (current commit IS the revert).
  2. Any log entry starts with "Revert" AND mentions sha (or sha.slice(0,7)) within
     windowHours: suppress (current commit is being reverted).

Window: config.capture.drafter?.revert_suppression_window_hours ?? 24

Wrapped in try/catch, returns false on any error (fail open).
execFileSync timeout: 50ms keeps hot path under 100ms budget.

Call site in postCommit() after line 265:
  if (isRevertSuppressed(projectRoot, sha, subject, config)) {
    debug("revert suppression: skipping"); return;
  }

## 6. Config Deep-Merge Confirmation

File: src/config.ts lines 107-122

deepMerge is a recursive plain-object merger.

capture.drafter.revert_suppression_window_hours: drafter is a plain object.
  deepMerge recurses into it and supplies the default if the field is absent. SAFE.

capture.classifier.editor_backup_patterns: classifier is a new plain-object sub-key.
  If absent from file config, DEFAULT_CONFIG value is used intact.
  editor_backup_patterns as an array is replaced wholesale (line 113 isArray check).
  Matches existing ignore_paths behavior. SAFE.
## 7. Test Files to Touch

All test files are standalone scripts; no framework.

src/capture/drafter.test.ts (Tests 1-4):
  No changes needed for Bugs 7 or 8 (key naming and scope enrichment are hook responsibility).
  Optionally add Test 5 for revert suppression; better covered at hook integration level.

src/capture/hook.test.ts (Tests 5-6):
  Test 5 (lines 140-180): change proposed_decision -> proposed_record at lines
    160, 163, 165, 166, 167, 170, 171.
    Add assertions for proposed_record.scope_type, scope_id, affected_files.
  Test 6 (lines 183-216): change lines 207-208 proposed_decision -> proposed_record.
  Add Test 7: revert commit within window -> postCommit writes no inbox items.
  Add Test 8: only *.bak files deleted -> no file-deletion inbox item written.
  Add Test 9: *.bak + real .ts file deleted -> file-deletion fires on .ts only.

src/smoke.ts (Tests 1-6): No changes needed; does not exercise inbox draft payloads.

src/mcp/smoke-test.ts (Tests 1-9):
  Test 3 confirm_pending uses item.proposed_record at line 120 (already correct).
  No functional test changes required.

## 8. Barrel Exports

src/ledger/index.ts:18 -- exports ProposedDecisionDraft.
  Adding scope fields propagates automatically. No barrel change needed.

src/capture/index.ts (lines 1-4) -- ClassifierCaptureConfig lives in src/config.ts.
  No capture barrel change needed.

src/retrieval/index.ts (lines 1-11) -- deriveScope signature unchanged. No barrel change needed.

ClassifierCaptureConfig should be exported from src/config.ts alongside DrafterCaptureConfig (line 15).
No other barrel needs updating.

## Critical Invariant Confirmation

JSONL append-only: All four fixes affect write-path behavior or config defaults.
  appendToInbox and appendToLedger in src/ledger/storage.ts remain untouched.
  No existing lines rewritten.

<100ms hook budget: Bug 9 git log uses execFileSync with timeout:50. Fail-open on any error.
  Rest of hook.ts logic unchanged.

No ledger.jsonl schema changes: DecisionRecord and TransitionEvent types unchanged.
  inbox.jsonl payload shape changes (proposed_record added, proposed_decision becomes alias)
  -- permitted per spec (inbox is a workflow queue, not the audit log).

MCP tool annotations unchanged: No tools added or removed. No parameters added.

Zero new runtime deps: editor-backup pattern matching implemented inline in classify.ts.

commit_inferred (weight 0.2) exclusion at src/retrieval/packs.ts:129. Untouched by all four fixes.
