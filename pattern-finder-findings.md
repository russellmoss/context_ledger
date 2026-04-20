# v1.2.1 Pattern-Finder Findings

## 1. Hook to Drafter to Inbox Flow End-to-End

Entry point: src/capture/hook.ts::postCommit() line 239. Invoked by the post-commit hook script installed by src/cli.ts init.

Pipeline with line numbers:
  1. execSync gets sha (line 253), subject (line 254), fullBody (line 255).
  2. execSync(git diff-tree) -> parseNameStatus(raw) produces ParsedDiff (lines 272-277). diff.all/deleted/added are the changed_files carriers.
  3. Paths normalized at lines 284-288.
  4. classifyCommit(diff.all, diff.deleted, diff.added, subject, config, pkgDiff) (line 299) returns ClassifyResult[]. Each result carries changed_files: string[].
  5. Tier-2 contradiction check block (lines 308-343) calls deriveScope, may upgrade a result tier. Uses already-loaded foldedState.
  6. For each result with inbox_type === draft_needed and drafter enabled (lines 359-396): calls deriveScope at line 372 for precedent context, then synthesizeDraft(). Result stored as proposed.
  7. buildInboxItem(result, sha, redactedMessage, redactedSummary, config, proposed) (line 400), function at lines 36-61. Sets commit_sha: sha (line 48), commit_message: redactedMessage (line 49), changed_files: [...result.changed_files].sort() (line 51). If proposedDecision truthy, attaches at line 59: item.proposed_decision = proposedDecision.
  8. appendToInbox(item, projectRoot) (line 401) -> src/ledger/storage.ts line 40: appendFile(inboxPath, JSON.stringify(item) + trailing-newline). Trailing newline always appended.

Bug 8 scope-field gap: buildInboxItem (line 36) never calls deriveScope. The drafter block (line 372) derives scope for precedent context only -- not plumbed into the inbox item. Fix: call deriveScope in or just before buildInboxItem and attach scope_type, scope_id, affected_files, scope_aliases to the item.

Bug 9 revert-check gate: Insert between steps 4 and 5 -- after results populated (line 300), before the per-result loop (line 352). New helper reads git log with bounded -n 20 via execSync, checks if any subject starts with Revert and references the current sha. If so, return early or empty results.

## 2. MCP propose_decision Flow

File: src/mcp/write-tools.ts

Builds two objects. The base InboxItem (lines 111-125) uses args.affected_files ?? [] for changed_files and args.summary for commit_message. Then the local PersistedInboxItem extension adds persisted.proposed_record (lines 130-147) with all scope fields: scope_type, scope_id, affected_files, scope_aliases, revisit_conditions, review_after, evidence_type, source, commit_sha.

proposed_record is the canonical shape. ProposedRecord interface is at lines 31-48. confirm_pending reads item.proposed_record at line 186 to construct the full DecisionRecord.

The hook drafter ProposedDecisionDraft (events.ts lines 78-86) lacks scope_type, scope_id, affected_files, scope_aliases, revisit_conditions, review_after, and the evidence/source/commit fields.

Key asymmetry driving Bug 7:
  - Hook writes key: proposed_decision (hook.ts line 59; events.ts line 102)
  - MCP writes key: proposed_record (write-tools.ts line 130)
  - confirm_pending reads item.proposed_record only (write-tools.ts line 186) -- hook-drafted items always hit the no-proposed-record-data error

## 3. Inbox Reader Patterns

src/retrieval/packs.ts: Receives inboxItems: InboxItem[] (line 73). The pending_inbox_items bucket (line 205) is inboxItems.filter(item => item.status === pending). The draft payload is NOT read here -- entire raw InboxItem passes through to consumer.

src/cli.ts::handleQuery() (lines 210-215): Renders pending inbox items printing i.type, i.inbox_id, i.commit_sha, i.change_category, i.commit_message. Does not render the draft payload. No variant-key fallback logic exists.

src/mcp/read-tools.ts: Calls queryDecisions(args, projectRoot) and JSON-serializes the entire pack. Draft payload fields serialize transparently.

rejection_reason backward-compatibility precedent (closest existing pattern):
  - events.ts:103: rejection_reason?: string (optional on InboxItem)
  - write-tools.ts:263: conditionally spread -- ...(args.reason ? { rejection_reason: args.reason } : {})
  - query.ts:225-234: existence check -- typeof item.rejection_reason === string && item.rejection_reason.length > 0
  - packs.ts:162: null-coalescing read -- rejection_reason: item.rejection_reason ?? empty-string

Pattern for proposed_record with fallback to proposed_decision: declare both keys optional on InboxItem. Canonical read in confirm_pending:
  const draft = item.proposed_record ?? (item as any).proposed_decision;
No write path should ever write proposed_decision going forward.

## 4. deriveScope Signature and Hook Accessibility

File: src/retrieval/scope.ts:31

Signature: deriveScope(params: { file_path?, query?, scope_type?, scope_id? }, config: LedgerConfig, decisions: Map<string, FoldedDecision>): DerivedScope | null

Hook already has all three at draft time: config loaded at line 246. foldedState loaded at line 313 (guarded: ledger size < 100 KB). foldedState?.decisions already passed to drafter invocation at line 375.

Cost assessment for Bug 8: Zero additional cost. Hook already calls deriveScope twice (lines 318 and 372). Fix adds a third call in or before buildInboxItem, passing foldedState?.decisions ?? new Map(). Derived scope gives scope_type and scope_id; affected_files comes from result.changed_files; scope_aliases is [] at draft time (no rename history available).

deriveScope already imported at hook.ts line 11 from ../retrieval/index.js.

## 5. Config Resolution Pattern

File: src/config.ts

loadConfig(projectRoot) reads .context-ledger/config.json, falls back to DEFAULT_CONFIG on ENOENT (line 93), then calls deepMerge(DEFAULT_CONFIG, fileConfig) (line 98).

deepMerge (lines 107-121): plain objects recurse; arrays, nulls, and primitives replace. A partial user config with capture: { drafter: { enabled: false } } merges field-by-field over the default drafter object.

Template for new config fields -- capture.drafter exists as a nested object (DrafterCaptureConfig, lines 15-20) with optional fields:
  - Add to DrafterCaptureConfig: revert_suppression_window_hours?: number
  - Add to DEFAULT_CONFIG.capture.drafter: revert_suppression_window_hours: 24
  - New capture.classifier block: add ClassifierCaptureConfig interface with editor_backup_patterns: string[]. DEFAULT_CONFIG.capture.classifier.editor_backup_patterns: [*.bak, *.orig, *.swp, *.swo, *~, .#*]

deepMerge handles arrays by replacement (line 113), so a user overriding editor_backup_patterns fully replaces the default -- correct for this use case.

## 6. File-Deletion Classification Logic

File: src/capture/classify.ts

Input structure: classifyCommit(changedFiles, deletedFiles, addedFiles, commitMessage, config, packageJsonDiff?) (line 162). Three separate pre-split arrays. Normalizes to del = delNorm.filter(...) (line 180).

File-deletion emission (lines 313-321):
  const unclaimed = del.filter((f) => !claimedFiles.has(f) && !isTestFile(f) && !isDocFile(f));
  if (unclaimed.length > 0) { results.push({ tier: 1, change_category: file-deletion, ... }); }
Single push conditional -- not a loop. claimedFiles set prevents double-counting with Tier-2 results.

Existing suppression template: isIgnored(p, ignorePaths) (lines 52-55) uses prefix matching against config.capture.ignore_paths. isTestFile and isDocFile (lines 37-45) use regex on normalized-lowercase paths.

Bug 10 implementation site: Add isEditorBackup(p, patterns) helper. Add as additional filter in unclaimed derivation at line 314:
  const unclaimed = del.filter(
    (f) => !claimedFiles.has(f) && !isTestFile(f) && !isDocFile(f)
          && !isEditorBackup(f, config.capture.classifier.editor_backup_patterns)
  );
No runtime dependencies; glob matching must be hand-rolled. Patterns like *.bak and .#* convert to regex: escape dots, map * to [^/]*, test against path.split(/).pop() (filename segment only).

## 7. Test Patterns

src/capture/drafter.test.ts: Four tests (Test 1-4). Pattern: installMock(fn) patches Anthropic.Messages.prototype.create (line 36). Tests call synthesizeDraft(args) directly. restoreMock() called in cleanup. No temp filesystem -- pure in-memory.

src/capture/hook.test.ts: Two tests (Test 5-6). Pattern:
  - bootstrapRepo() creates a temp git repo with an initial seed commit (line 75).
  - writeConfig(root, drafterEnabled) writes minimal config (line 91).
  - commitNewAuthDir(root) uses src/newmodule/ not src/auth/ to hit Tier-1 new-directory (line 113 comment explains).
  - runPostCommitIn(root) sets CONTEXT_LEDGER_PROJECT_ROOT env var (line 131).
  - readInboxItems(root) reads and parses inbox.jsonl (line 120).
  - Cleanup: rm(root, { recursive: true, force: true }) in finally.

src/smoke.ts: Six tests with underscore-separator names (test1_fullPipeline etc.). Pattern: setupTempProject(config?) creates temp dir; makeDecision/makeTransition are factory helpers; assert(condition, label) increments passed/failed counters. Runner collects dirs, cleans all in a single finally block.

For v1.2.1 acceptance tests: Bugs 7/8/9 extend hook.test.ts as Test 7/8/9. Bug 10 lives in a new classify.test.ts. Test numbering continues sequentially from Test 6.

## 8. Shellout and Budget Patterns

execSync usage in hook.ts: lines 128-133 (isMergeCommit), 253-255 (sha/subject/body), 272 (diff-tree), 175/179 (git show package.json), 211/215 (env changes). All use { cwd: projectRoot, encoding: utf8, stdio: pipe }. Failures caught with bare try/catch returning safe defaults.

execFileSync used for getCommitDiff (lines 74-82) with explicit maxBuffer: 16 * 1024 * 1024. All failures return empty string.

Timeout handling: No explicit timeout option on any execSync / execFileSync call. Bug 9 git log call follows the same fail-open pattern: wrap in try/catch, return false (do not suppress) on any error.

Performance note for Bug 9: git log --format=%H%x00%s -n 20 is a bounded read (20 commits max, minimal format). Use execSync consistent with lines 253-255.

## 9. Backward-Compatible Read Precedent

rejection_reason is the canonical precedent:
  - Type declaration (events.ts:103): rejection_reason?: string
  - Write (write-tools.ts:263): conditionally spread, never set to undefined
  - Read with guard (query.ts:225): typeof item.rejection_reason === string && item.rejection_reason.length > 0
  - Read with null-coalesce (packs.ts:162): item.rejection_reason ?? empty-string

For proposed_record / proposed_decision unification:
  1. Add proposed_record?: ProposedRecord to InboxItem in events.ts (keep proposed_decision?: ProposedDecisionDraft as read-only legacy).
  2. Hook buildInboxItem writes item.proposed_record (never proposed_decision).
  3. confirm_pending in write-tools.ts line 186: const proposed = item.proposed_record ?? (item as any).proposed_decision;
  4. For legacy items where only proposed_decision exists, fields missing in ProposedDecisionDraft (scope_type, scope_id, etc.) get empty-string defaults before constructing DecisionRecord.
  5. hook.test.ts Tests 5 and 6 must update assertions from proposed_decision key to proposed_record key.

## Key Files Reference

| File | Relevance |
|---|---|
| C:/Users/russe/Documents/Context_Ledger/src/capture/hook.ts | Lines 36-61 (buildInboxItem), 308-396 (fold + drafter), 352-405 (per-result loop) |
| C:/Users/russe/Documents/Context_Ledger/src/capture/classify.ts | Lines 313-321 (file-deletion emission), 162-169 (function signature) |
| C:/Users/russe/Documents/Context_Ledger/src/capture/drafter.ts | Lines 18-26 (ProposedDecision type), 199-255 (synthesizeDraft) |
| C:/Users/russe/Documents/Context_Ledger/src/mcp/write-tools.ts | Lines 31-53 (ProposedRecord, PersistedInboxItem), 130-147 (proposed_record write), 186 (read) |
| C:/Users/russe/Documents/Context_Ledger/src/ledger/events.ts | Lines 78-104 (ProposedDecisionDraft, InboxItem, rejection_reason) |
| C:/Users/russe/Documents/Context_Ledger/src/retrieval/scope.ts | Lines 31-35 (deriveScope signature) |
| C:/Users/russe/Documents/Context_Ledger/src/config.ts | Lines 15-20 (DrafterCaptureConfig), 55-84 (DEFAULT_CONFIG), 107-122 (deepMerge) |
| C:/Users/russe/Documents/Context_Ledger/src/ledger/storage.ts | Lines 39-41 (appendToInbox trailing-newline pattern) |
| C:/Users/russe/Documents/Context_Ledger/src/capture/hook.test.ts | Lines 75-89 (bootstrapRepo), 108-118 (commitNewAuthDir), 120-127 (readInboxItems) |
| C:/Users/russe/Documents/Context_Ledger/src/capture/drafter.test.ts | Lines 34-39 (mock install pattern), 46-63 (fixture builders) |
| C:/Users/russe/Documents/Context_Ledger/src/smoke.ts | Lines 22-30 (assert harness), 73-81 (setupTempProject), 379-407 (runner) |
