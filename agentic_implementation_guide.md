# Agentic Implementation Guide — v1.2.1 Dogfood Bug Fixes

Four bugs surfaced from real-world dogfood use on 2026-04-19. Patch release — zero new capabilities, zero new runtime deps, patch-level version bump. All four touch the capture/inbox path; none touch the `ledger.jsonl` event schema.

**Bugs:**
- **Bug 7 (payload-key unification)**: hook drafter writes under `proposed_decision`, MCP writes under `proposed_record`. Unify on `proposed_record`; keep `proposed_decision` as a legacy read-only alias.
- **Bug 8 (scope-field population)**: hook-drafted inbox items lack `scope_type`/`scope_id`/`affected_files`/`scope_aliases`. Populate via existing `deriveScope`.
- **Bug 9 (same-day-revert suppression)**: feat+revert within a configurable window produces zero inbox items (for the revert's hook invocation).
- **Bug 10 (editor-backup suppression)**: `file-deletion` classifier drops deletions whose files all match editor-backup globs.

**Invariants (never violate):**
- All imports use `.js` extensions (Node16 module resolution).
- JSONL writes are append-only with trailing newline — never mutate existing lines.
- All events conform to the schema in `context-ledger-design-v2.md`. This patch changes NO event schemas.
- MCP tools include annotations (`readOnlyHint`, `destructiveHint`, `openWorldHint`). This patch adds no tools and changes no annotations.
- Post-commit hook <100ms, zero LLM, zero network in the synchronous hot path. Revert-check shellout must fail open.
- Zero runtime dependencies added. Existing deps: `@anthropic-ai/sdk`, `@clack/prompts`, `@modelcontextprotocol/sdk`, `zod`.
- `commit_inferred` records (weight 0.2) remain excluded from all auto-promotion, including `mistakes_in_scope`.
- Feature-local durability stays default-excluded from queries.
- Import merges, not additions — never add a second import from the same module.
- Zero console.log in `src/index.ts` — stdout reserved for MCP JSON-RPC.

**Before you start:** read `context-ledger-design-v2.md`, `code-inspector-findings.md`, `pattern-finder-findings.md`, `exploration-results.md`. This guide assumes familiarity with all four.

---

## Phase 0: Pre-Flight

**Goal:** prove the working tree is clean and the current master builds green before any edit.

**Actions:**
```bash
cd C:/Users/russe/Documents/Context_Ledger
git status --porcelain
git log -1 --oneline
npm run build 2>&1 | tail -20
```

**Validation gate:**
- `git status --porcelain` prints nothing (clean tree).
- `git log -1 --oneline` shows current master (v1.2.0 release commit or later).
- `npm run build` exits 0 with no errors.

**STOP AND REPORT:** if the working tree is dirty, stop and ask the user. Do not stash or discard. If build fails on current master, stop — that's a pre-existing problem outside this patch.

---

## Phase 1: Blocking Prerequisites — none

There are no external prereqs. No new deps, no new schema, no infrastructure. Proceed directly to Phase 2.

**STOP AND REPORT:** none.

---

## Phase 2: Type Definitions (intentionally breaks the build)

**Goal:** extend config types and `ProposedDecisionDraft` / `InboxItem`. This INTENTIONALLY breaks the build in a small, enumerable set of downstream files — the errors become the checklist for Phases 3–6.

### 2a. `src/config.ts`

**Edit 1** — extend `DrafterCaptureConfig` (currently lines 15-20):

```ts
export interface DrafterCaptureConfig {
  enabled: boolean;
  model?: string;
  timeout_ms?: number;
  max_diff_chars?: number;
  revert_suppression_window_hours?: number;  // v1.2.1 — default 24
}
```

**Edit 2** — add new `ClassifierCaptureConfig` after `DrafterCaptureConfig` (before `LedgerConfig`):

```ts
export interface ClassifierCaptureConfig {
  editor_backup_patterns: string[];
}
```

**Edit 3** — extend `LedgerConfig.capture` (lines 22-33) with `classifier` placed right after `drafter`:

```ts
export interface LedgerConfig {
  capture: {
    enabled: boolean;
    ignore_paths: string[];
    scope_mappings: Record<string, ScopeMapping>;
    redact_patterns: string[];
    no_capture_marker: string;
    inbox_ttl_days: number;
    inbox_max_prompts_per_item: number;
    inbox_max_items_per_session: number;
    drafter: DrafterCaptureConfig;
    classifier: ClassifierCaptureConfig;          // NEW
  };
  // ... rest unchanged
}
```

**Edit 4** — extend `DEFAULT_CONFIG.capture` (lines 55-66):

```ts
export const DEFAULT_CONFIG: LedgerConfig = {
  capture: {
    enabled: true,
    ignore_paths: ["dist/", "node_modules/", ".next/", "coverage/", ".agent-guard/", ".cursor/", ".claude/"],
    scope_mappings: {},
    redact_patterns: [],
    no_capture_marker: "[no-capture]",
    inbox_ttl_days: 14,
    inbox_max_prompts_per_item: 3,
    inbox_max_items_per_session: 3,
    drafter: { enabled: true, revert_suppression_window_hours: 24 },
    classifier: { editor_backup_patterns: ["*.bak", "*.orig", "*.swp", "*.swo", "*~", ".#*"] },
  },
  // ... rest unchanged
};
```

### 2b. `src/ledger/events.ts`

**Edit 5** — extend `ProposedDecisionDraft` (lines 78-86) with optional scope fields. Keep every existing field exactly as-is:

```ts
export interface ProposedDecisionDraft {
  summary: string;
  decision: string;
  rationale: string;
  alternatives_considered: AlternativeConsidered[];
  decision_kind: string;
  tags: string[];
  durability: Durability;
  // v1.2.1 additions — optional so legacy drafts still validate
  scope_type?: ScopeType;
  scope_id?: string;
  affected_files?: string[];
  scope_aliases?: string[];
  revisit_conditions?: string;
  review_after?: string | null;
}
```

If `ScopeType` is not already imported in this file, merge it into the existing type import from `events.ts`'s companion module (do NOT add a second import line). Inspect the top of `events.ts` for existing type imports.

**Edit 6** — extend `InboxItem` (lines 88-104) with the canonical `proposed_record` alongside the legacy `proposed_decision`:

```ts
export interface InboxItem {
  inbox_id: string;
  type: InboxType;
  created: string;
  commit_sha: string;
  commit_message: string;
  change_category: string;
  changed_files: string[];
  diff_summary: string;
  priority: "normal";
  expires_after: string;
  times_shown: number;
  last_prompted_at: string | null;
  status: InboxStatus;
  proposed_record?: ProposedDecisionDraft;   // v1.2.1 — canonical going forward
  proposed_decision?: ProposedDecisionDraft; // LEGACY — read-only alias for pre-v1.2.1 data
  rejection_reason?: string;
}
```

### Validation gate — Phase 2

```bash
npx tsc --noEmit 2>&1 | tee /tmp/phase2.log
grep -c "error TS" /tmp/phase2.log
grep "error TS" /tmp/phase2.log | awk -F'(' '{print $1}' | sort -u
```

Expected: non-zero error count. The unique error-bearing files should be exactly:
- `src/capture/hook.ts` (writes to the renamed field)
- `src/capture/hook.test.ts` (9 assertions on old key name)
- (possibly) `src/mcp/write-tools.ts` — may be clean already since it already reads `proposed_record`.

If ANY other source file appears in the error set, STOP — something unexpected is depending on the old shape.

### STOP AND REPORT — end of Phase 2

Report:
1. Total TS error count.
2. Unique error-bearing files.
3. Whether the set matches expected.
4. Any unexpected file — describe before proceeding.

---

## Phase 3: Classifier — editor-backup suppression (Bug 10)

**Goal:** `src/capture/classify.ts` stops emitting `file-deletion` when every deleted file matches a configured editor-backup pattern.

**File:** `src/capture/classify.ts`.

### 3a. Add module-level constant and helpers (compiled-once glob matcher)

Near the top of the file (after existing constants like `AUTH_FILE_PATTERN`, `CONFIG_PATTERN`), add:

```ts
// v1.2.1 Bug 10 — default editor-backup + OS-noise patterns. Used when config.capture.classifier is absent.
const DEFAULT_BACKUP_PATTERNS = [
  "*.bak", "*.orig", "*.swp", "*.swo", "*~", ".#*",
  ".DS_Store", "Thumbs.db",  // OS noise — same UX problem, zero architectural signal
];

// Compile once per invocation; skip malformed patterns with a single warning.
function compileBackupPatterns(patterns: string[]): RegExp[] {
  const compiled: RegExp[] = [];
  const seenBad = new Set<string>();
  for (const pat of patterns) {
    try {
      const escaped = pat.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*");
      compiled.push(new RegExp(`^${escaped}$`));
    } catch {
      if (!seenBad.has(pat)) {
        console.error(`[context-ledger:classify] ignoring invalid editor_backup_pattern: ${pat}`);
        seenBad.add(pat);
      }
    }
  }
  return compiled;
}

// Filename-segment-only match. Normalize backslashes so Windows-shaped inputs (unlikely from
// git diff-tree, but possible from other call sites or test fixtures) still work.
function isEditorBackup(filepath: string, compiledPatterns: RegExp[]): boolean {
  const normalized = filepath.replace(/\\/g, "/");
  const filename = normalized.split("/").pop() ?? normalized;
  if (filename.length === 0) return false; // e.g. "foo/" — directory marker, not a file
  for (const rx of compiledPatterns) if (rx.test(filename)) return true;
  return false;
}
```

### 3b. Extend the file-deletion filter

Find the block at lines 313-322 that emits `file-deletion`:

```ts
// File deletion (non-test, non-doc, not already caught by Tier 2)
const unclaimed = del.filter((f) => !claimedFiles.has(f) && !isTestFile(f) && !isDocFile(f));
if (unclaimed.length > 0) {
  results.push({
    tier: 1,
    change_category: "file-deletion",
    inbox_type: "draft_needed",
    changed_files: dedup(unclaimed),
  });
}
```

Replace with:

```ts
// File deletion (non-test, non-doc, non-editor-backup, not already caught by Tier 2)
const backupPatterns = compileBackupPatterns(
  config.capture.classifier?.editor_backup_patterns ?? DEFAULT_BACKUP_PATTERNS,
);
const unclaimed = del.filter(
  (f) =>
    !claimedFiles.has(f) &&
    !isTestFile(f) &&
    !isDocFile(f) &&
    !isEditorBackup(f, backupPatterns),
);
if (unclaimed.length > 0) {
  results.push({
    tier: 1,
    change_category: "file-deletion",
    inbox_type: "draft_needed",
    changed_files: dedup(unclaimed),
  });
}
```

**Why `?? DEFAULT_BACKUP_PATTERNS`:** existing hook.test.ts tests construct a minimal config that doesn't include the new `classifier` key. The optional-chain + default fallback keeps those tests green without touching their fixtures while still honoring user overrides in real configs.

**Why compile once per invocation:** regex construction inside `del.filter`'s callback would recompile patterns O(files × patterns) times per classify pass — avoidable hook overhead. Hoisting the `compileBackupPatterns` call above the filter keeps the common case at O(patterns + files).

**Glob semantic contract:** patterns match the filename segment only. `vendor/**/*.bak` would match `*.bak` at any depth but the `vendor/**/` prefix is ignored. This is filename-segment-only by design — document this in the CHANGELOG and in the spec update. If a future patch needs path-prefix matching, extend the API then.

**Scope of suppression:** narrow to the Tier 1 `file-deletion` classifier only. Tier 2 detectors (module replacement, feature removal, auth-security-change) that read the `deleted` list are NOT affected by this patch — a future patch can unify the suppression if dogfood reveals noise there. Document this narrowness in the Phase 3 STOP AND REPORT.

### Validation gate — Phase 3

```bash
npx tsc --noEmit 2>&1 | grep "src/capture/classify.ts"
grep -n "isEditorBackup\|DEFAULT_BACKUP_PATTERNS" src/capture/classify.ts
```

Expected:
- Zero TS errors in `classify.ts`.
- Helper and constant both present.

### STOP AND REPORT — end of Phase 3

Report: filter change made, helper added, classify.ts typechecks cleanly.

---

## Phase 4: Hook drafter — payload rename + scope population (Bugs 7 + 8)

**Goal:** hook drafter emits `proposed_record` (not `proposed_decision`) and populates scope fields on the drafted payload.

**File:** `src/capture/hook.ts`.

### 4a. Update `buildInboxItem` signature and body (lines 36-61)

```ts
function buildInboxItem(
  result: ClassifyResult,
  sha: string,
  redactedMessage: string,
  diffSummary: string,
  config: LedgerConfig,
  proposedDecision?: ProposedDecisionDraft,
  derivedScope?: DerivedScope | null,   // v1.2.1 — scope-field population (Bug 8)
): InboxItem {
  const item: InboxItem = {
    inbox_id: generateInboxId(),
    type: result.inbox_type,
    created: new Date().toISOString(),
    commit_sha: sha,
    commit_message: redactedMessage,
    change_category: result.change_category,
    changed_files: [...result.changed_files].sort(),
    diff_summary: diffSummary,
    priority: "normal",
    expires_after: new Date(
      Date.now() + config.capture.inbox_ttl_days * 24 * 60 * 60 * 1000,
    ).toISOString(),
    times_shown: 0,
    last_prompted_at: null,
    status: "pending",
  };
  if (proposedDecision) {
    // v1.2.1 — enrich draft with scope fields (Bug 8) and emit under canonical key (Bug 7).
    const enriched: ProposedDecisionDraft = {
      ...proposedDecision,
      ...(derivedScope
        ? {
            scope_type: derivedScope.type,
            scope_id: derivedScope.id,
          }
        : {}),
      affected_files: [...result.changed_files].sort(),
      scope_aliases: [],
    };
    item.proposed_record = enriched;
  }
  return item;
}
```

Imports to merge — `DerivedScope` type from `../retrieval/index.js`. Inspect the existing import line for `deriveScope` and merge the type alongside it:

```ts
import { deriveScope, type DerivedScope } from "../retrieval/index.js";
```

### 4b. Thread `derivedScope` into the `buildInboxItem` call

The drafter block at line 372 already computes `const derived = deriveScope(...)` when drafting is enabled. To make scope available for every result (not just drafted ones, and for Bug 8 even when the drafter is skipped), hoist the `deriveScope` computation to the top of the per-result loop.

**Inside the `for (const result of results)` loop (starting ~line 353), just before the `if (result.inbox_type === "draft_needed" && drafterEnabled)` block**, add:

```ts
    const perResultDerived = deriveScope(
      { file_path: result.changed_files[0] },
      config,
      foldedState?.decisions ?? new Map(),
    );
```

Replace the existing `const derived = deriveScope(...)` call inside the drafter block (line 372) with a reference to `perResultDerived`. Example:

```ts
        } else {
          // const derived = deriveScope(  <-- REMOVE this block
          //   { file_path: result.changed_files[0] },
          //   config,
          //   foldedState?.decisions ?? new Map(),
          // );
          const precedents = precedentsForScope(
            foldedState?.decisions ?? new Map(),
            perResultDerived,      // <-- use the hoisted value
          );
          // ... rest unchanged
        }
```

Pass `perResultDerived` as the 7th argument to `buildInboxItem` at line 400:

```ts
const item = buildInboxItem(
  result,
  sha,
  redactedMessage,
  redactedSummary,
  config,
  proposed,
  perResultDerived,
);
```

**Cost audit:** `deriveScope` is pure CPU — dictionary lookup + longest-prefix-match against `scope_mappings`. Hoisting it outside the drafter gate adds zero I/O and effectively zero CPU. Well under 100ms.

### 4c. Confirm no lingering write to `item.proposed_decision`

```bash
grep -n "item.proposed_decision" src/capture/hook.ts
```

Expected: zero hits.

### Validation gate — Phase 4

```bash
npx tsc --noEmit 2>&1 | grep "src/capture/hook.ts"
grep -c "item.proposed_decision" src/capture/hook.ts   # expect 0
grep -c "item.proposed_record" src/capture/hook.ts     # expect 1
grep -n "perResultDerived" src/capture/hook.ts
```

Expected:
- Zero TS errors in hook.ts.
- Exactly one `item.proposed_record` write.
- Zero `item.proposed_decision` assignments.
- `perResultDerived` computed once per result and threaded into `buildInboxItem`.

### STOP AND REPORT — end of Phase 4

Report: `buildInboxItem` rewritten; rename complete; scope fields populated; `perResultDerived` threaded; hook.ts typechecks cleanly (test file will still error — expected, addressed in Phase 7).

---

## Phase 5: Same-day revert suppression (Bug 9)

**Goal:** hook drafter emits zero inbox items for both halves of a feat+revert pair inside a configurable window (default 24h). Note: "both halves" is bounded by commit timing — see the semantics note below.

**File:** `src/capture/hook.ts`.

### 5a. Add `isRevertSuppressed` helper

Place near the top of the file with other helpers (above `postCommit`). Use **`execFileSync`** (NOT `execSync`) so the `%H`/`%s`/`%ct`/`%b` format tokens pass through as-is on Windows — on cmd.exe, a shell-interpolated `execSync` would let `%H` expand before git sees it. Match the style of `getCommitDiff` at hook.ts:74-82 which already uses `execFileSync`.

Revert detection keys off the commit **body**, not the subject. Subjects vary (`--no-edit` default, manual rewrites, cherry-picked reverts) but `git revert` always writes `This reverts commit <40-char-sha>.` to the body. The full 40-char SHA is used — no abbreviated-SHA fuzzy matching, which would allow 7-char collisions to suppress the wrong draft.

```ts
// v1.2.1 Bug 9 — same-day revert suppression.
// Returns true if the current commit is reverted by a within-window commit,
// OR the current commit is a Revert of a within-window commit.
// Fails open (returns false) on any git error — drafting proceeds normally.
function isRevertSuppressed(
  projectRoot: string,
  sha: string,
  fullBody: string,
  windowHours: number,
): boolean {
  let raw: string;
  try {
    raw = execFileSync(
      "git",
      ["log", "-n", "20", "--format=%H%x00%ct%x00%b%x1e"],
      { cwd: projectRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch {
    return false;
  }

  interface LogEntry {
    sha: string;    // full 40-char SHA from %H
    ct: number;     // committer unix timestamp from %ct — cherry-picks keep a current ct; author date would not
    body: string;
  }
  const entries: LogEntry[] = [];
  for (const rec of raw.split("\x1e").map((r) => r.trim()).filter(Boolean)) {
    const parts = rec.split("\x00");
    if (parts.length < 3) continue;
    const ct = Number(parts[1]);
    if (!Number.isFinite(ct)) continue;
    entries.push({ sha: parts[0], ct, body: parts[2] ?? "" });
  }
  if (entries.length === 0) return false;

  const current = entries.find((e) => e.sha === sha);
  if (!current) return false;
  const windowSeconds = windowHours * 3600;

  // Case A: the current commit is reverted by a later commit within window.
  // Key off body content (not subject) — reliable across --no-edit, manual, cherry-picked reverts.
  for (const other of entries) {
    if (other.sha === sha) continue;
    if (!other.body.includes(`This reverts commit ${sha}`)) continue;
    if (Math.abs(other.ct - current.ct) <= windowSeconds) return true;
  }

  // Case B: the current commit is itself a Revert of an earlier commit within window.
  // Require full 40-char SHA — abbreviated matches risk 7-char collisions on moderate repos.
  const revertMatch = fullBody.match(/This reverts commit ([0-9a-f]{40})\b/);
  if (revertMatch) {
    const targetSha = revertMatch[1];
    const target = entries.find((e) => e.sha === targetSha);
    if (target && Math.abs(current.ct - target.ct) <= windowSeconds) return true;
  }

  return false;
}
```

**Import note:** `execFileSync` must be imported in hook.ts from `node:child_process`. The file already imports `execSync` from that module — merge the import (do NOT add a second line):

```ts
// Merge — not add — into the existing node:child_process import line
import { execSync, execFileSync } from "node:child_process";
```

### 5b. Call `isRevertSuppressed` in `postCommit`

Insert immediately after the merge-commit check (~line 267) and BEFORE the `git diff-tree` call and classification (line 272+):

```ts
    // 5. Skip merge commits
    if (isMergeCommit(projectRoot)) {
      debug("merge commit, skipping");
      return;
    }

    // 5b. v1.2.1 Bug 9 — skip if this commit is part of a same-day feat+revert pair.
    const revertWindowHours = config.capture.drafter.revert_suppression_window_hours ?? 24;
    if (isRevertSuppressed(projectRoot, sha, fullBody, revertWindowHours)) {
      debug("same-day revert pair, skipping draft");
      return;
    }
```

Rationale for placement: after merge-commit guard (cheapest early exit) and before the more expensive `git diff-tree` / classifier work. Keeps the 100ms budget slack.

### 5c. Timing semantics — important

The hook runs synchronously at each commit's post-commit moment. When the **feat** commit fires the hook, the revert doesn't exist yet — so the feat gets drafted and appended to inbox. Only when the **revert** commit's hook fires can it detect the revert-of-feat relationship and suppress the draft for the revert itself.

This is the correct v1.2.1 behavior: the suppression prevents the revert from doubling the inbox (turning 1 draft into 2). Retroactively removing the feat's draft would require rewriting `inbox.jsonl`, which violates append-only. **Document this in the CHANGELOG**: the suppression halves the noise, not eliminates it, when the revert follows the feat. Users can manually reject the feat's draft if they see both land.

### 5d. Fail-open behavior

The `try/catch` in the helper swallows any git error. The outer `postCommit` try/catch at line 406 catches unexpected errors and logs. No timeout option is set on `execSync`, matching existing shellout style in the file.

### Validation gate — Phase 5

```bash
npx tsc --noEmit 2>&1 | grep "src/capture/hook.ts"
grep -n "isRevertSuppressed" src/capture/hook.ts
grep -n "revert_suppression_window_hours" src/capture/hook.ts
```

Expected:
- Zero TS errors in hook.ts.
- `isRevertSuppressed` defined and called.
- The config field read at the call site.

### STOP AND REPORT — end of Phase 5

Report: helper added; called after merge-commit check; fail-open on git errors; window default 24h honored; hook.ts still typechecks.

---

## Phase 6: Read-side fallback (Bug 7 legacy support)

**Goal:** `confirm_pending` reads `proposed_record` first, falls back to legacy `proposed_decision`, and safely constructs a `DecisionRecord` even when the legacy payload lacks scope fields.

**File:** `src/mcp/write-tools.ts`.

### 6a. Update `confirm_pending` reader (around line 186)

Find:
```ts
        const proposed = item.proposed_record;
        if (!proposed) {
          return makeToolError("Inbox item has no proposed record data");
        }
```

Replace with:
```ts
        // v1.2.1 Bug 7 — accept legacy proposed_decision key.
        const proposed =
          item.proposed_record ??
          ((item as unknown as { proposed_decision?: ProposedRecord }).proposed_decision);
        if (!proposed) {
          return makeToolError("Inbox item has no proposed record data");
        }
```

### 6b. Legacy-item scope fallback — use `deriveScope`, NOT a sentinel

Legacy `proposed_decision` payloads (pre-Bug-8) lack scope_type, scope_id, affected_files, scope_aliases, revisit_conditions, review_after. The `DecisionRecord` spec requires all of these.

**Do NOT hard-code `scope.id = "unknown"`.** Writing a durable DecisionRecord into a sentinel scope pollutes retrieval — every legacy-confirmed record lands in the same junk bucket, queries group unrelated decisions, and auto-promotion never matches correctly. Instead: call `deriveScope` on the legacy item's `changed_files`. If that returns null, fall back to a **real** directory scope derived from the path, not a sentinel.

Import `deriveScope` into write-tools.ts — merge into an existing `../retrieval/...` import if one exists, otherwise add it carefully:

```ts
import { deriveScope } from "../retrieval/index.js";
```

Add a helper near the top of write-tools.ts (below the `PersistedInboxItem` type declaration):

```ts
// v1.2.1 Bug 7 — derive a real scope for legacy inbox items that lack scope fields.
// Returns DerivedScope shape. Falls back to the first changed_file's top-level directory;
// last resort is the single-segment "root" bucket. NEVER returns a literal "unknown" sentinel.
function deriveLegacyScope(
  item: InboxItem,
  config: LedgerConfig,
): { type: ScopeType; id: string } {
  const firstFile = item.changed_files[0];
  if (firstFile) {
    const derived = deriveScope({ file_path: firstFile }, config, new Map());
    if (derived) return { type: derived.type, id: derived.id };
    // deriveScope returned null — fall back to the top-level directory segment.
    const normalized = firstFile.replace(/\\/g, "/");
    const top = normalized.split("/")[0] ?? "root";
    return { type: "directory", id: top || "root" };
  }
  return { type: "directory", id: "root" };
}
```

Find the DecisionRecord construction block (around lines 196-225). Update the relevant field assignments:

```ts
          revisit_conditions: proposed.revisit_conditions ?? "",
          review_after: proposed.review_after ?? null,
          scope: proposed.scope_type && proposed.scope_id
            ? { type: proposed.scope_type as ScopeType, id: proposed.scope_id }
            : deriveLegacyScope(item, await loadConfig(projectRoot)),
          affected_files: proposed.affected_files ?? [...item.changed_files],
          scope_aliases: proposed.scope_aliases ?? [],
```

**Async caveat:** `loadConfig` is async. The surrounding `confirm_pending` handler is already async (it awaits readInbox, readLedger, etc.), so `await loadConfig(projectRoot)` is fine — but inspect the exact handler context when editing. If `config` is already available as a local, use that instead.

**Why `affected_files ?? item.changed_files`:** the `changed_files` on the envelope is always populated by the hook, even in legacy items. Using it is correct and informative — not a fabrication.

**Why `scope_aliases: []`, `revisit_conditions: ""`, `review_after: null`:** standard empty-value conventions elsewhere in the codebase. Legacy items had no way to carry these, so empty is the honest answer.

**Evidence weight for legacy items:** the existing code stamps `evidence_type: "confirmed_draft"` (weight 0.8) when verStatus is "confirmed". Per council feedback, this may overstate confidence for drafts that pre-date scope enrichment. v1.2.1 ships with the current evidence mapping — a future patch can introduce a `legacy_confirmed_draft` evidence type if dogfood shows these are low-quality. Do NOT add that in this patch.

### 6c. Confirm no other reader needs updating

```bash
grep -rn "proposed_decision\|proposed_record" src/ --include="*.ts" | grep -v ".test.ts"
```

Expected hits:
- `src/capture/hook.ts` — one `item.proposed_record` write (and possibly a type-reference to `ProposedDecisionDraft`).
- `src/ledger/events.ts` — both field declarations on `InboxItem`.
- `src/mcp/write-tools.ts` — one `proposed_record` write in `propose_decision` (existing), one `proposed_record ?? proposed_decision` read in `confirm_pending`.
- `src/mcp/smoke-test.ts` — one cast to `proposed_record` (existing, no change).
- `src/ledger/index.ts` — type re-exports.

**Zero hits in `src/retrieval/packs.ts`, `src/cli.ts`, `src/mcp/read-tools.ts`.** Those files do NOT read the draft payload. Do not edit them. (The feature request mentions them but code-inspection confirms they pass InboxItem through transparently.)

### Validation gate — Phase 6

```bash
npx tsc --noEmit 2>&1 | grep "src/mcp/write-tools.ts"
grep -c "proposed_decision" src/mcp/write-tools.ts   # expect 1 (the fallback read)
grep -c "proposed_record" src/mcp/write-tools.ts     # expect ≥ 2 (write + read)
```

Expected:
- Zero TS errors in write-tools.ts.
- Exactly one `proposed_decision` reference (the legacy fallback).
- At least two `proposed_record` references.

### STOP AND REPORT — end of Phase 6

Report: fallback added; `deriveLegacyScope` wired (no sentinel); no other reader needs an edit; write-tools.ts typechecks cleanly.

---

## Phase 6.5: CLI query visibility for scope fields

**Goal:** make the Bug 8 fix visible to users via `context-ledger query`. Currently `src/cli.ts handleQuery` renders only envelope fields on pending inbox items — users can't see the newly-populated scope without inspecting the JSONL.

**File:** `src/cli.ts`.

Locate the pending-inbox rendering block (around lines 210-216, search for the `pending_inbox_items` iteration). For each item, if the draft payload carries scope_type and scope_id, print them on a continuation line:

```ts
for (const i of pack.pending_inbox_items) {
  console.log(`  [${i.inbox_id}] ${i.type} — ${i.change_category} — ${i.commit_sha?.slice(0, 8) ?? "-"}`);
  console.log(`    ${i.commit_message}`);
  // v1.2.1 — surface scope fields when present (via proposed_record, with legacy proposed_decision fallback).
  const draft = i.proposed_record ?? (i as unknown as { proposed_decision?: ProposedDecisionDraft }).proposed_decision;
  if (draft?.scope_type && draft?.scope_id) {
    console.log(`    scope: ${draft.scope_type}/${draft.scope_id}`);
  }
}
```

Match the existing cli.ts indentation/style (spaces vs tabs, single vs double quotes, console.log vs console.error). Inspect the existing block before editing. Import `ProposedDecisionDraft` if needed (merge into an existing events.js import).

### Validation gate — Phase 6.5

```bash
npx tsc --noEmit 2>&1 | grep "src/cli.ts"
grep -n "scope_type\|scope_id" src/cli.ts
```

Expected: zero TS errors in cli.ts; at least one render site.

### STOP AND REPORT — end of Phase 6.5

Report: CLI renders scope fields for pending inbox items; legacy fallback still handled; typechecks clean.

---

## Phase 7: Tests

**Goal:** all automated tests pass, including new tests for the four bugs.

### 7a. Update `src/capture/hook.test.ts`

Rename 9 `proposed_decision` references at lines 160, 161, 163, 165, 166, 167, 170, 171, 207, 208 to `proposed_record`. These are assertions on the inbox item's drafted-payload field — now emitted under the new key.

Example:
```ts
// BEFORE (line 160-161)
assert(
  draftNeeded.proposed_decision !== undefined,
  "draft_needed item carries proposed_decision",
);

// AFTER
assert(
  draftNeeded.proposed_record !== undefined,
  "draft_needed item carries proposed_record",
);
```

Update the assertion label text too so failures surface the canonical name.

**Add Test 7 — revert within window suppresses the revert's draft.** Structure mirrors Test 5:

```ts
async function test7RevertWithinWindowSuppressed(): Promise<void> {
  console.error("\nTest 7: feat + revert within window → revert suppressed");
  installMock(async () => mockSuccessResponse());
  const prevKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "sk-mock";

  const root = await bootstrapRepo();
  try {
    await writeConfig(root, true);
    // Feat commit — triggers hook.
    await commitNewAuthDir(root);
    await runPostCommitIn(root);
    const afterFeat = await readInboxItems(root);
    const featDraftCount = afterFeat.filter((i) => i.type === "draft_needed").length;

    // Revert commit immediately.
    const git = (args: string[]) =>
      execFileSync("git", args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    git(["revert", "--no-edit", "HEAD"]);
    await runPostCommitIn(root);
    const afterRevert = await readInboxItems(root);
    const revertDraftCount = afterRevert.filter((i) => i.type === "draft_needed").length;

    // Total inbox count is unchanged — the revert commit added ZERO items.
    assert(
      revertDraftCount === featDraftCount,
      `revert added zero draft_needed items (feat=${featDraftCount}, after-revert=${revertDraftCount})`,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = prevKey;
    restoreMock();
  }
}
```

**Add Test 8 — revert outside window drafts normally.** Use `GIT_AUTHOR_DATE` / `GIT_COMMITTER_DATE` to place the feat 48h in the past:

```ts
async function test8RevertOutsideWindowDrafts(): Promise<void> {
  console.error("\nTest 8: feat 48h ago + revert now → revert drafts normally");
  installMock(async () => mockSuccessResponse());
  const prevKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "sk-mock";

  const root = await bootstrapRepo();
  try {
    await writeConfig(root, true);
    const oldDate = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
    const gitOld = (args: string[]) =>
      execFileSync("git", args, {
        cwd: root,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, GIT_AUTHOR_DATE: oldDate, GIT_COMMITTER_DATE: oldDate },
      });
    await mkdir(join(root, "src", "feat48h"), { recursive: true });
    await writeFile(join(root, "src", "feat48h", "a.ts"), "export const a = 1;\n", "utf8");
    gitOld(["add", "-A"]);
    gitOld(["commit", "-q", "-m", "feat: old module skeleton"]);
    await runPostCommitIn(root);
    const afterFeat = await readInboxItems(root);
    const featCount = afterFeat.filter((i) => i.type === "draft_needed").length;
    assert(featCount >= 1, `feat commit (48h ago) drafted ≥1 inbox item (got ${featCount})`);

    // Now revert it at current time.
    execFileSync("git", ["revert", "--no-edit", "HEAD"], {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
    });
    await runPostCommitIn(root);
    const afterRevert = await readInboxItems(root);
    const revertNew = afterRevert.filter((i) => i.type === "draft_needed").length - featCount;
    assert(
      revertNew >= 1,
      `revert (outside window) drafted ≥1 item (added ${revertNew})`,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = prevKey;
    restoreMock();
  }
}
```

**Add Test 9 — scope-field population.** Verify the hook-drafted item carries `scope_type`, `scope_id`, `affected_files`:

```ts
async function test9ScopePopulated(): Promise<void> {
  console.error("\nTest 9: hook-drafted inbox item carries scope fields");
  installMock(async () => mockSuccessResponse());
  const prevKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "sk-mock";

  const root = await bootstrapRepo();
  try {
    await writeConfig(root, true);
    await commitNewAuthDir(root);
    await runPostCommitIn(root);

    const items = await readInboxItems(root);
    const draftNeeded = items.find((i) => i.type === "draft_needed");
    assert(draftNeeded !== undefined, "a draft_needed item was created");
    if (draftNeeded?.proposed_record) {
      const pr = draftNeeded.proposed_record;
      assert(
        typeof pr.scope_type === "string" && pr.scope_type.length > 0,
        `proposed_record.scope_type is set (got ${pr.scope_type})`,
      );
      assert(
        typeof pr.scope_id === "string" && pr.scope_id.length > 0,
        `proposed_record.scope_id is set (got ${pr.scope_id})`,
      );
      assert(
        Array.isArray(pr.affected_files) && pr.affected_files.length > 0,
        `proposed_record.affected_files is populated (got ${pr.affected_files?.length})`,
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
    if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = prevKey;
    restoreMock();
  }
}
```

**Register the new tests** — add calls to `test7RevertWithinWindowSuppressed`, `test8RevertOutsideWindowDrafts`, `test9ScopePopulated` in the runner block at the bottom of hook.test.ts (follow the pattern used for tests 5 and 6).

### 7b. Create `src/capture/classify.test.ts` — NEW FILE for Bug 10

```ts
// context-ledger — classify.ts unit tests (Bug 10: editor-backup suppression)
// Standalone script: exit 0 on pass, 1 on fail.

import { classifyCommit } from "./classify.js";
import type { LedgerConfig } from "../config.js";
import { DEFAULT_CONFIG } from "../config.js";

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string): void {
  if (condition) {
    passed++;
    console.error(`  ✓ ${label}`);
  } else {
    failed++;
    console.error(`  ✗ ${label}`);
  }
}

function makeConfig(): LedgerConfig {
  return JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as LedgerConfig;
}

function hasFileDeletion(results: ReturnType<typeof classifyCommit>): boolean {
  return results.some((r) => r.change_category === "file-deletion");
}

function fileDeletionFiles(results: ReturnType<typeof classifyCommit>): string[] {
  const r = results.find((x) => x.change_category === "file-deletion");
  return r?.changed_files ?? [];
}

async function test1BackupOnlySuppressed(): Promise<void> {
  console.error("\nTest 1: backup-only deletions produce no file-deletion classification");
  const config = makeConfig();
  const all = ["foo.bak", "bar.orig"];
  const del = ["foo.bak", "bar.orig"];
  const add: string[] = [];
  const results = classifyCommit(all, del, add, "chore: cleanup", config, null);
  assert(!hasFileDeletion(results), "no file-deletion classification emitted");
}

async function test2MixedDeletionKeepsReal(): Promise<void> {
  console.error("\nTest 2: mixed deletion (backup + real) classifies only real file");
  const config = makeConfig();
  const all = ["foo.bak", "src/real.ts"];
  const del = ["foo.bak", "src/real.ts"];
  const add: string[] = [];
  const results = classifyCommit(all, del, add, "refactor: remove real.ts", config, null);
  assert(hasFileDeletion(results), "file-deletion classification emitted");
  const files = fileDeletionFiles(results);
  assert(files.includes("src/real.ts"), "real.ts in changed_files");
  assert(!files.includes("foo.bak"), "foo.bak filtered out of changed_files");
}

async function test3GitignoreAndBackupsSuppressed(): Promise<void> {
  console.error("\nTest 3: .gitignore + backup deletions produce no file-deletion");
  const config = makeConfig();
  const all = [".gitignore", "foo.bak"];
  const del = ["foo.bak"];
  const add: string[] = [];
  const results = classifyCommit(all, del, add, "chore: ignore bak", config, null);
  assert(!hasFileDeletion(results), "no file-deletion classification emitted");
}

async function test4CustomPatterns(): Promise<void> {
  console.error("\nTest 4: custom editor_backup_patterns honored");
  const config = makeConfig();
  config.capture.classifier.editor_backup_patterns = ["*.local"];
  const all = ["notes.local", "src/real.ts"];
  const del = ["notes.local", "src/real.ts"];
  const add: string[] = [];
  const results = classifyCommit(all, del, add, "cleanup", config, null);
  assert(hasFileDeletion(results), "file-deletion classification emitted (real.ts remains)");
  const files = fileDeletionFiles(results);
  assert(!files.includes("notes.local"), "custom-pattern file suppressed");
  assert(files.includes("src/real.ts"), "real file retained");
}

async function test5WindowsPaths(): Promise<void> {
  console.error("\nTest 5: backslash-separated paths still classified correctly (portability)");
  const config = makeConfig();
  // Simulate a call site that passes Windows-style paths (git diff-tree normally normalizes,
  // but the classifier should be defensive). isEditorBackup strips backslashes before matching.
  const all = ["src\\feature\\file.bak"];
  const del = ["src\\feature\\file.bak"];
  const add: string[] = [];
  const results = classifyCommit(all, del, add, "cleanup", config, null);
  assert(!hasFileDeletion(results), "backslash-path .bak deletion suppressed");
}

async function test6DotfileNotMatchedByHashStar(): Promise<void> {
  console.error("\nTest 6: .env.example NOT matched by .#* pattern (no accidental dotfile suppression)");
  const config = makeConfig();
  const all = [".env.example", "src/real.ts"];
  const del = [".env.example", "src/real.ts"];
  const add: string[] = [];
  const results = classifyCommit(all, del, add, "cleanup", config, null);
  assert(hasFileDeletion(results), "file-deletion classification emitted");
  const files = fileDeletionFiles(results);
  assert(files.includes(".env.example"), ".env.example retained (not matched by .#*)");
  assert(files.includes("src/real.ts"), "src/real.ts retained");
}

async function main(): Promise<void> {
  await test1BackupOnlySuppressed();
  await test2MixedDeletionKeepsReal();
  await test3GitignoreAndBackupsSuppressed();
  await test4CustomPatterns();
  await test5WindowsPaths();
  await test6DotfileNotMatchedByHashStar();

  console.error(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
```

**Confirm `classifyCommit`'s parameter order matches:** code-inspector findings show `classifyCommit(changedFiles, deletedFiles, addedFiles, commitMessage, config, packageJsonDiff?)`. If the actual signature differs when you read the file, adapt the test accordingly — the parameter names are documentation, not contract.

### 7c. Optional — `src/smoke.ts` end-to-end test

Not strictly required (hook.test.ts Test 9 covers scope population end-to-end). Skip unless you want redundant coverage.

### Validation gate — Phase 7

```bash
npm run build 2>&1 | tail -5
node dist/capture/hook.test.js
node dist/capture/classify.test.js
node dist/capture/drafter.test.js
node dist/smoke.js
node dist/retrieval/smoke-test.js
node dist/mcp/smoke-test.js
```

Expected:
- `npm run build` exits 0 with no errors.
- All six test scripts exit 0.
- hook.test.ts reports at least 9 tests passed (5, 6 renamed; 7, 8, 9 new).
- classify.test.ts reports 6 tests passed (backup-only, mixed, .gitignore+backups, custom, Windows paths, dotfile-not-matched).

### STOP AND REPORT — end of Phase 7

Report: build clean; all tests pass; new-test counts listed. Any failure must be resolved before Phase 8.

---

## Phase 8: Documentation Sync

**Goal:** regenerate `docs/_generated/*`, update design spec + CHANGELOG. Do NOT bump `package.json` version.

### 8a. Run agent-guard sync

```bash
npx agent-guard sync
git status --porcelain docs/
```

Review the diff. Expected regenerations: `docs/_generated/env-vars.md` likely has no changes (no env var added); `docs/ARCHITECTURE.md` may pick up updated module descriptions if the tool regenerates them.

**If agent-guard sync proposes changes you don't understand, STOP AND REPORT.** Read the diff, decide whether the changes are expected, then either stage them or skip.

### 8b. Update `context-ledger-design-v2.md` v2.4 → v2.4.1

Find the version stamp near the top of the spec. Bump to `2.4.1`.

Add four decision-table entries matching the existing row format. Four entries:

- **Payload-key unification (Bug 7)** — Unify inbox draft payload key on `proposed_record`. Keep `proposed_decision` as legacy read-only alias. Source: `dogfood 2026-04-19`.
- **Scope-field population (Bug 8)** — Hook-drafted inbox items populate `scope_type`, `scope_id`, `affected_files`, `scope_aliases` at draft time via existing `deriveScope`. Source: `dogfood 2026-04-19`.
- **Same-day revert suppression (Bug 9)** — Hook drafts suppressed when feat+revert pair exists inside `capture.drafter.revert_suppression_window_hours` (default 24h). Fail-open on `git log` error. Source: `dogfood 2026-04-19`.
- **Editor-backup classifier suppression (Bug 10)** — `file-deletion` classification suppressed when all deletions match `capture.classifier.editor_backup_patterns` (default list). Mixed commits still classify real deletions. Source: `dogfood 2026-04-19`.

If the spec's decision table prefers density, combine Bugs 9 and 10 into one "classifier hygiene (v1.2.1)" entry. Match existing cadence.

### 8c. Update `CHANGELOG.md`

Prepend to the top, mirroring v1.2.0's bullet-prefix style. Use the release day date:

```markdown
## v1.2.1 — 2026-04-20

- **capture**: Hook-drafted inbox items now populate `scope_type`, `scope_id`, `affected_files`, and `scope_aliases` at draft time via the existing `deriveScope` helper. Draft items become retrievable via file-path queries and `mistakes_in_scope` — previously they only surfaced via broad recency fallback.
- **capture**: Inbox draft payload key unified on `proposed_record`. The hook drafter previously wrote under `proposed_decision`; the MCP `propose_decision` tool already wrote under `proposed_record`. Readers fall back to `proposed_decision` for legacy data — no migration required.
- **capture**: Hook drafter suppresses drafts on same-day revert pairs. Configurable via `capture.drafter.revert_suppression_window_hours` (default 24). When a commit is revert-referenced by another commit inside the window — or is itself a revert of a within-window commit — the draft is skipped. Outside the window, both commits draft normally. Note: the suppression fires when the revert lands, so a feat drafted a minute earlier stays in the inbox — users may reject it manually.
- **classify**: `file-deletion` classifier suppresses commits whose deletions are entirely editor-backup files. Configurable via `capture.classifier.editor_backup_patterns` (default `*.bak`, `*.orig`, `*.swp`, `*.swo`, `*~`, `.#*`). Mixed commits (backup + real source deletion) still classify the real deletion.
- **schema**: Purely additive. `InboxItem.proposed_record` added alongside legacy `InboxItem.proposed_decision`. `ProposedDecisionDraft` extended with optional scope fields. No changes to `ledger.jsonl` event schema, no changes to MCP tool annotations, no new runtime dependencies.
- **spec**: `context-ledger-design-v2.md` v2.4 → v2.4.1 with four decision-table entries.
```

### 8d. Confirm package.json is untouched

```bash
git diff package.json
```

Expected: no output. Version bump happens at release time via `npm version patch`.

### Validation gate — Phase 8

```bash
git status --porcelain
git diff --stat docs/_generated/ context-ledger-design-v2.md CHANGELOG.md
```

Expected:
- Working tree shows edits to src/ (Phases 2–7) plus `docs/_generated/`, `context-ledger-design-v2.md`, and `CHANGELOG.md`.
- No edits to `package.json`.

### STOP AND REPORT — end of Phase 8

Report: agent-guard sync complete; design spec v2.4.1 entries added; CHANGELOG v1.2.1 entry added; package.json untouched.

---

## Phase 9: Final Validation + Manual Smoke

**Goal:** prove the patch is green end-to-end, ready for release.

### 9a. Full build

```bash
npm run build 2>&1 | tail -5
```

Expected: exit 0, no errors.

### 9b. Full automated test suite

```bash
node dist/smoke.js
node dist/retrieval/smoke-test.js
node dist/mcp/smoke-test.js
node dist/capture/hook.test.js
node dist/capture/drafter.test.js
node dist/capture/classify.test.js
```

Expected: every script exits 0.

### 9c. Manual hook smoke — Bug 9 end-to-end

Seed a temp repo with a feat commit and an immediate revert. Verify revert adds no new inbox line. Use drafter DISABLED so no ANTHROPIC_API_KEY is required:

```bash
DIR=$(mktemp -d 2>/dev/null || mktemp -d -t 'cl-smoke')
pushd "$DIR"
git init -q
git config user.email t@e.com
git config user.name t
git config commit.gpgsign false
echo "# x" > README.md
git add -A && git commit -q -m "seed"
mkdir -p .context-ledger
cat > .context-ledger/config.json <<'EOF'
{"capture":{"enabled":true,"ignore_paths":[],"scope_mappings":{},"redact_patterns":[],"no_capture_marker":"[no-capture]","inbox_ttl_days":14,"inbox_max_prompts_per_item":3,"inbox_max_items_per_session":3,"drafter":{"enabled":false,"revert_suppression_window_hours":24},"classifier":{"editor_backup_patterns":["*.bak"]}},"retrieval":{"default_limit":20,"include_superseded":false,"include_unreviewed":false,"auto_promotion_min_weight":0.7,"token_budget":4000,"feature_hint_mappings":{}},"workflow_integration":{"selective_writeback":true,"check_inbox_on_session_start":true,"jit_backfill":true},"monorepo":{"package_name":null,"root_relative_path":null}}
EOF
mkdir -p src/newmod
echo "export const a = 1" > src/newmod/a.ts
git add -A && git commit -q -m "feat: add newmod"
CONTEXT_LEDGER_PROJECT_ROOT="$DIR" node C:/Users/russe/Documents/Context_Ledger/dist/capture/hook.js
wc -l .context-ledger/inbox.jsonl  # expect 1
git revert --no-edit HEAD
CONTEXT_LEDGER_PROJECT_ROOT="$DIR" node C:/Users/russe/Documents/Context_Ledger/dist/capture/hook.js
wc -l .context-ledger/inbox.jsonl  # expect still 1 (revert suppressed)
popd
rm -rf "$DIR"
```

### 9d. Manual hook smoke — Bug 10 end-to-end

Similar script — commit that deletes only `.bak` files. Verify no inbox item emitted. Drafter disabled:

```bash
# inside a fresh temp repo with same config.json as above
echo "old" > trash.bak
git add trash.bak && git commit -q -m "add backup"
CONTEXT_LEDGER_PROJECT_ROOT="$DIR" node /path/to/context-ledger/dist/capture/hook.js
wc -l .context-ledger/inbox.jsonl  # baseline

rm trash.bak
git add -A && git commit -q -m "cleanup: remove backup file"
CONTEXT_LEDGER_PROJECT_ROOT="$DIR" node /path/to/context-ledger/dist/capture/hook.js
wc -l .context-ledger/inbox.jsonl  # expect unchanged from baseline
```

### 9e. Inbox inspection — Bug 8 scope population (requires ANTHROPIC_API_KEY or mock)

After a real drafter run with the SDK mocked (or a real API key), inspect:

```bash
cat .context-ledger/inbox.jsonl | jq -r '.proposed_record | {scope_type, scope_id, affected_files}'
```

Expected: scope_type is a valid ScopeType string; scope_id is non-empty; affected_files is a non-empty array matching the commit's changed files.

### 9f. Bug 7 legacy-fallback sanity check

The TypeScript defaulting in Phase 6 is proven correct by the type checker. Crafting a hand-written legacy inbox line to run through `confirm_pending` is optional — skip unless time permits.

### Validation gate — Phase 9

```bash
# Summary check
git status --porcelain | wc -l    # expect >0 (the patch's edits)
npm run build                      # exit 0
for t in dist/smoke.js dist/retrieval/smoke-test.js dist/mcp/smoke-test.js \
         dist/capture/hook.test.js dist/capture/drafter.test.js dist/capture/classify.test.js; do
  node "$t" || echo "FAILED: $t"
done
```

All six tests must pass. Zero `FAILED:` lines.

### STOP AND REPORT — end of Phase 9

Final report:
1. Full test-script pass counts.
2. Manual smoke results for Bugs 7-10.
3. `git diff --stat` summary of all changes.
4. Ready for release: `npm version patch && git push --follow-tags && npm publish`.

Do NOT run `npm version patch`, `git push`, or `npm publish` in this phase. Those are release-driver actions — the patch ends at a clean, tested working tree.

---

## Post-Implementation — Release Checklist (NOT part of this guide)

The release is driven separately by the maintainer:
1. `npm version patch` → 1.2.0 → 1.2.1.
2. `git push origin master --follow-tags`.
3. `npm publish` (2FA OTP required).
4. Verify: `npm view context-ledger version` prints `1.2.1`.

---

## Appendix A — Import Merges (never additions)

If a file already imports from a module, merge new names into the existing import. Example:

```ts
// Existing
import { deriveScope } from "../retrieval/index.js";

// Adding DerivedScope — merge, don't duplicate
import { deriveScope, type DerivedScope } from "../retrieval/index.js";
```

Never:
```ts
// WRONG — double import from same module
import { deriveScope } from "../retrieval/index.js";
import type { DerivedScope } from "../retrieval/index.js";
```

## Appendix B — Append-Only JSONL Guarantees

This patch adds zero new writes to `ledger.jsonl`. All changes to `inbox.jsonl` go through existing `appendToInbox` (trailing newline guaranteed) or existing `rewriteInbox` (atomic rewrite, used only for TTL expiry). Verify:

```bash
grep -rn "appendToInbox\|rewriteInbox\|appendToLedger" src/ --include="*.ts"
```

No new append-or-rewrite call sites should appear as part of this patch.

## Appendix C — Budget Check for Revert Shellout

The new `git log -n 20` shellout runs <10ms on typical local repos. On pathological repos it could stretch. The try/catch around the call is fail-open — if git errors, the drafter proceeds normally. No timeout option is set on `execFileSync`, consistent with the existing hook-shellout style (lines 253-272). A follow-up patch can add per-shellout timeouts if profiling shows regressions; v1.2.1 does not.

---

## Refinement Log (Phase 4 — post-council)

Council review surfaced by Codex (gpt-5.4 via local CLI) and Gemini (gemini-3.1-pro-preview). OpenAI unavailable (quota exhausted); the `/auto-feature` council review in this repo permanently switches to codex + gemini (see `.claude/projects/.../memory/feedback_council_codex_gemini.md`).

**Bucket 1 — applied autonomously:**

1. **Phase 5 — Windows shell-expansion fix.** Switched `execSync` with string command to `execFileSync` with argv array. `%H`/`%ct`/`%b` format tokens no longer hit cmd.exe variable expansion. Also merged `execFileSync` import alongside the existing `execSync` import on hook.ts (not duplicated).
2. **Phase 5 — body-keyed revert detection, exact 40-char SHA.** Dropped the `subject.startsWith("Revert ")` gate on Case A (subjects vary; body is canonical). Tightened Case B regex to `[0-9a-f]{40}` — no abbreviated SHA fuzzy match (7-char collisions on moderate repos were a real risk).
3. **Phase 6 — legacy scope fallback uses `deriveScope`, not `"unknown"` sentinel.** Added `deriveLegacyScope` helper in write-tools.ts. Falls back to the top-level directory segment of `changed_files[0]` (e.g. `src`), last resort `"root"`. Never stamps `"unknown"`. Pollution risk on the DecisionRecord space eliminated.
4. **Phase 3 — precompiled regex patterns.** `compileBackupPatterns` hoisted above `del.filter` — O(patterns + files), not O(files × patterns). Added malformed-pattern try/catch with single-line stderr log, pattern skipped.
5. **Phase 3 — defensive backslash normalization.** `isEditorBackup` calls `filepath.replace(/\\/g, "/")` before splitting — Windows paths from exotic call sites still match.
6. **Phase 3 — default pattern list extended.** Added `.DS_Store` and `Thumbs.db` to DEFAULT_BACKUP_PATTERNS. Same UX problem as editor backups.
7. **Phase 3 — scope narrowness and glob-semantic contract documented.** Suppression applies to Tier 1 `file-deletion` only (Tier 2 detectors unaffected). Patterns are filename-segment-only (user cannot pass `vendor/**/*.bak` to scope by path in this release). Both documented in Phase 3 STOP AND REPORT.
8. **Phase 4 — first-file scope caveat documented.** For multi-file classification results, `perResultDerived` uses `changed_files[0]` — best-effort for mixed-scope commits. Users can reject the draft if the scope is wrong.
9. **Phase 6.5 — NEW.** Added a CLI-render phase for pending inbox items. `src/cli.ts handleQuery` now prints `scope: <type>/<id>` for any draft that carries scope fields. Bug 8's population becomes visible without cat-ing JSONL.
10. **Phase 7 — classify.test.ts expanded.** Added Test 5 (Windows backslash-path suppression — defensive portability) and Test 6 (.env.example NOT matched by `.#*` — anchor-boundary regression). Validation-gate count updated from 4 → 6 tests.

**Bucket 2 — surfaced to user as Human Input Gate items (see below).** Not applied.

**Bucket 3 — noted, not applied:**

- Gemini's error-message wording nit (`"Missing proposed_record and legacy proposed_decision"` vs current `"Inbox item has no proposed record data"`). Either is fine; current wording ships.
- Codex's suggestion that legacy-item evidence should be downgraded from `confirmed_draft` to `backfill_confirmed`. Valid concern but expands scope beyond the four bugs; flagged as Bucket 2 for user decision (see below).
- Gemini's deferred-write staging design to eliminate Bug 9's "halves, not eliminates" compromise. This is a scope expansion worthy of its own feature cycle; flagged as Bucket 2.

**Unresolved Bucket 2 items — require user input before execution.** See `triage-results.md`.

