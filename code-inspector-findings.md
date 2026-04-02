# Code Inspector Findings — capture/ Implementation

## 1. Key Types

### InboxItem (`src/ledger/events.ts:78-92`)
- `inbox_id: string` — `q_{unix}_{hex2}` via `generateInboxId()`
- `type: InboxType` — `"draft_needed" | "question_needed"`
- `created: string` — ISO 8601
- `commit_sha: string`, `commit_message: string`, `change_category: string`
- `changed_files: string[]`, `diff_summary: string`
- `priority: "normal"` — literal type
- `expires_after: string` — ISO 8601 TTL
- `times_shown: number`, `last_prompted_at: string | null`, `status: InboxStatus`

### LedgerConfig capture section (`src/config.ts:15-25`)
- `enabled: boolean` (default: true)
- `ignore_paths: string[]` (default: `["dist/", "node_modules/", ".next/", "coverage/"]`)
- `scope_mappings: Record<string, ScopeMapping>`
- `redact_patterns: string[]` (default: `[]`)
- `no_capture_marker: string` (default: `"[no-capture]"`)
- `inbox_ttl_days: number` (default: 14)

### FoldedDecision (`src/ledger/fold.ts:16-23`)
- `record: DecisionRecord`, `state: LifecycleState`, `replaced_by: string | null`
- `reinforcement_count: number`, `effective_rank_score: number`, `transitions: TransitionEvent[]`

### DerivedScope (`src/retrieval/scope.ts:17-21`)
- `type: ScopeType`, `id: string`, `source: ScopeSource`

## 2. InboxItem Construction Sites (Patterns)

### Site 1: `src/cli.ts` backfill (lines 727-742)
```typescript
const item: InboxItem = {
  inbox_id: generateInboxId(), type: "draft_needed",
  created: new Date().toISOString(), commit_sha, commit_message,
  change_category, changed_files,
  diff_summary: `Backfill from commit ${sha.slice(0, 8)}`,
  priority: "normal",
  expires_after: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(),
  times_shown: 0, last_prompted_at: null, status: "pending",
};
await appendToInbox(item, projectRoot);
```

### Site 2: `src/mcp/write-tools.ts` propose_decision (lines 111-125)
Same pattern. Also uses `PersistedInboxItem = InboxItem & { client_operation_id?, proposed_record? }`.

## 3. Key Functions

| Function | File | Signature |
|----------|------|-----------|
| `appendToInbox` | `src/ledger/storage.ts:39-42` | `(item: InboxItem, projectRoot: string) => Promise<void>` |
| `readInbox` | `src/ledger/storage.ts:70-92` | `(projectRoot: string) => Promise<InboxItem[]>` ([] on ENOENT) |
| `foldLedger` | `src/ledger/fold.ts:110-113` | `(projectRoot: string, options?: FoldOptions) => Promise<MaterializedState>` |
| `deriveScope` | `src/retrieval/scope.ts:31-35` | `(params, config, decisions) => DerivedScope \| null` |
| `loadConfig` | `src/config.ts:79-90` | `(projectRoot: string) => Promise<LedgerConfig>` (DEFAULT on ENOENT) |
| `generateInboxId` | `src/ledger/events.ts:124-128` | `() => string` (`q_{unix}_{hex2}`) |
| `normalizePath` | `src/retrieval/scope.ts:25-27` | `(p: string) => string` (backslash→forward, strip ./, lowercase) |

## 4. Existing src/capture/ — All 3 files are 2-line stubs

## 5. Reference classifyCommit in cli.ts (lines 633-653)
Basic Tier 1 only. Missing: new-directory detection, file deletion via diff-filter, Tier 2 categories, config-aware ignore_paths/no_capture_marker.

## 6. Barrel Exports
- `src/capture/index.ts` — replace stub with barrel (classifyCommit, postCommit)
- `src/ledger/index.ts` — NO changes needed (already exports everything)
- `src/retrieval/index.ts` — NO changes needed

## 7. Design Spec Capture Rules (from context-ledger-design-v2.md)

### Tier 1 (draft_needed):
- package.json dependency add/remove
- .env.example additions
- New directory with multiple files
- Files/directories deleted
- Config file changes (tsconfig, eslint, CI)
- New API route or page route
- DB schema/migration changes

### Tier 2 (question_needed):
- Module replacement (library swap)
- Contradicts active ledger decision (same scope + structural signal)
- Auth/security pattern changes
- DB migration or provider switch
- Feature/capability removal

### Ignored:
- Content-only edits (no dir create/delete)
- Test files (unless new test dir)
- Style/formatting, documentation
- Files matching ignore_paths
- Commits with [no-capture]
