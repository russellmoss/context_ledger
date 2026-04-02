# Exploration Results — Post-Commit Hook Capture System (src/capture/)

Date: 2026-04-01
Sources: code-inspector-findings.md, pattern-finder-findings.md, context-ledger-design-v2.md

---

## Pre-Flight Summary

Implementing the capture pipeline: 3 new files in src/capture/ (classify.ts, hook.ts, index.ts) plus a package.json script update. All core infrastructure exists — InboxItem type, appendToInbox, generateInboxId, foldLedger, deriveScope, loadConfig are all implemented and barrel-exported. The existing classifyCommit in cli.ts is a partial reference but missing new-directory detection, diff-filter deletion signals, Tier 2 categories, and config awareness. The hook must: (1) execute under 100ms, (2) never block git commits, (3) use only console.error, (4) append-only to inbox.jsonl, (5) apply redact_patterns before writing. Tier 2 contradiction detection requires foldLedger + deriveScope which adds latency on large ledgers — needs a fast-path gate.

---

## Files to Modify

| File | Action | What Changes |
|------|--------|-------------|
| `src/capture/classify.ts` | Replace stub | Full classifier: Tier 1/2/null with config-aware ignore_paths, no_capture_marker |
| `src/capture/hook.ts` | Replace stub | Post-commit entry: git commands → classify → group → append inbox items |
| `src/capture/index.ts` | Replace stub | Barrel exports for classifyCommit, ClassifyResult, postCommit |
| `package.json` | Add script | `"postcommit": "node dist/capture/hook.js"` |

---

## Type Changes

### New types in classify.ts (not exported from ledger — local to capture module):

```typescript
export interface ClassifyResult {
  tier: 1 | 2 | null;            // null = ignored
  change_category: string;        // e.g. "dependency-addition", "auth-security-change"
  inbox_type: InboxType | null;   // "draft_needed" | "question_needed" | null
  changed_files: string[];        // filtered files that triggered this classification
}
```

No changes to existing types in events.ts, config.ts, or fold.ts.

---

## Construction Site Inventory

### InboxItem construction in hook.ts (NEW — follows backfill pattern from cli.ts:727-742):
```typescript
const item: InboxItem = {
  inbox_id: generateInboxId(),
  type: result.inbox_type!,      // "draft_needed" or "question_needed"
  created: new Date().toISOString(),
  commit_sha: sha,
  commit_message: redactedMessage,
  change_category: result.change_category,
  changed_files: result.changed_files,
  diff_summary: redactedSummary,
  priority: "normal",
  expires_after: new Date(Date.now() + config.capture.inbox_ttl_days * 24 * 60 * 60 * 1000).toISOString(),
  times_shown: 0,
  last_prompted_at: null,
  status: "pending",
};
```

### Existing construction sites (NO changes needed):
- `src/cli.ts:727-742` — backfill InboxItem (unchanged)
- `src/mcp/write-tools.ts:111-125` — propose_decision InboxItem (unchanged)

---

## Recommended Phase Order

1. **Phase 1: classify.ts** — Pure function, no I/O dependencies. Export ClassifyResult type and classifyCommit function.
2. **Phase 2: hook.ts** — Depends on classify.ts. Git commands → classify → group → redact → append.
3. **Phase 3: index.ts barrel** — Depends on both files existing.
4. **Phase 4: package.json** — Script addition.
5. **Phase 5: Build + test** — tsc, manual smoke test with a test commit.

---

## Risks and Blockers

1. **Tier 2 latency**: `foldLedger` reads and parses full ledger.jsonl. At 500+ events, this could push hook over 100ms. Mitigation: only call foldLedger when Tier 2 signals are present (auth/security paths, structural changes in mapped scopes). Skip fold entirely for pure Tier 1 commits.

2. **git diff-tree on initial commit**: `git diff-tree HEAD` fails when HEAD is the first commit (no parent). Mitigation: try/catch, fallback to `git diff-tree --root HEAD`.

3. **Multiple inbox items per commit**: Design spec requires grouping by "file proximity and change type" for commits with multiple unrelated structural changes. This is the most complex part — need a grouping algorithm that clusters changed files by directory prefix and classification category.

4. **redact_patterns are regexes**: Must compile them and handle invalid patterns gracefully (try/catch on `new RegExp()`).

5. **execSync on Windows**: `git diff-tree` works on Windows but path separators will be forward-slash (git's output). normalizePath handles this.

---

## Design Spec Compliance

| Spec Requirement | Implementation | Compliant? |
|-----------------|---------------|------------|
| Hook under 100ms | execSync + sync classify + async append | Yes (with Tier 2 gate) |
| Zero LLM calls | Deterministic heuristics only | Yes |
| Zero network calls | Local git + local JSONL only | Yes |
| Append-only to inbox.jsonl | Uses appendToInbox | Yes |
| redact_patterns applied before write | Applied to diff_summary and commit_message | Yes |
| no_capture_marker check | Early exit if found in commit message | Yes |
| ignore_paths filtering | Applied to changed_files before classify | Yes |
| capture.enabled gate | Early exit if false | Yes |
| Multiple inbox items per commit | Grouped by file proximity + change type | Yes |
| Tier 1 categories (7) | All 7 from spec | Yes |
| Tier 2 categories (5) | All 5 from spec | Yes |
| 14-day TTL | Uses config.capture.inbox_ttl_days | Yes |
| All output to stderr | console.error only | Yes |
| Graceful error handling | try/catch entire hook, exit 0 on error | Yes |

No deviations from spec.
