# Agentic Implementation Guide — Post-Commit Hook Capture System (src/capture/)

**Feature:** Deterministic post-commit hook classifier + inbox writer
**Spec:** context-ledger-design-v2.md (Capture: Two Tiers, Security and Redaction sections)
**Exploration:** exploration-results.md, code-inspector-findings.md, pattern-finder-findings.md
**Council Review:** council-feedback.md — all Bucket 1 fixes applied
**Human Input:** All 6 Bucket 2 questions answered and applied

---

## Pre-Implementation Checklist

Before starting, verify:

```bash
# 1. Build passes clean
npx tsc --noEmit

# 2. Stub files exist
ls src/capture/classify.ts src/capture/hook.ts src/capture/index.ts

# 3. Core dependencies are implemented
grep -c "appendToInbox" src/ledger/storage.ts    # expect >= 1
grep -c "generateInboxId" src/ledger/events.ts   # expect >= 1
grep -c "foldLedger" src/ledger/fold.ts           # expect >= 1
grep -c "deriveScope" src/retrieval/scope.ts      # expect >= 1
grep -c "loadConfig" src/config.ts                # expect >= 1
```

If build fails or any dependency is missing, fix before proceeding.

---

## Phase 1: Classifier (src/capture/classify.ts)

### What to build
A pure function that classifies a commit into Tier 1 (draft_needed) or Tier 2 (question_needed) based on deterministic heuristics and config. Returns only actionable results — empty array for ignored commits. Zero I/O, zero LLM calls.

### File: `src/capture/classify.ts`

Replace the 2-line stub entirely.

### Exports

```typescript
export interface ClassifyResult {
  tier: 1 | 2;
  change_category: string;
  inbox_type: "draft_needed" | "question_needed";
  changed_files: string[];
}

export interface ParsedPackageJson {
  addedDeps: string[];     // e.g. ["@google/genai@^1.46.0"]
  removedDeps: string[];   // e.g. ["old-lib"]
  otherChanges: boolean;   // true if scripts/version/etc changed but no dep changes
}

export function classifyCommit(
  changedFiles: string[],
  deletedFiles: string[],
  addedFiles: string[],
  commitMessage: string,
  config: LedgerConfig,
  packageJsonDiff?: ParsedPackageJson | null,
): ClassifyResult[];
```

Note: Returns an **array** of ClassifyResult — one per detected change cluster. The design spec (v2.1) requires multiple inbox items per commit for unrelated structural changes. Returns empty array `[]` for ignored commits — no null tiers or null inbox_types in results.

### Imports

```typescript
import type { LedgerConfig } from "../config.js";
```

### Classification Logic

**Path normalization (apply first to ALL file arrays):**
Replace `\` with `/`, strip leading `./`, lowercase for matching. Preserve original paths in `changed_files` output.

**Early exits (return `[]`):**
1. `config.capture.enabled === false`
2. No files after filtering (empty commit or all ignored)

Note: `no_capture_marker` check happens in hook.ts before calling classifyCommit, using the full commit body (`%B`), not just subject.

**Filter changed files:**
Remove any file whose normalized path starts with any entry in `config.capture.ignore_paths`. Apply to all three arrays (changedFiles, addedFiles, deletedFiles).

**Ignored patterns (return `[]` if ALL remaining files match):**
- Test files: `*.test.*`, `*.spec.*`, `__tests__/`, `__mocks__/` — UNLESS addedFiles include a new test directory
- Documentation: `*.md`, `docs/`, `README*`, `LICENSE*`, `CHANGELOG*`
- Style/formatting: `.css`, `.scss`, `.less`, `styles/`, `.prettierrc` (config-change takes priority over style-ignore)

**Tier 2 triggers (check FIRST — Tier 2 takes priority):**

| Category | Detection |
|----------|-----------|
| `"module-replacement"` | deletedFiles in one directory AND addedFiles in a different directory at same depth, both containing implementation files (not tests/docs) |
| `"auth-security-change"` | Any file path contains `auth/`, `middleware/`, `permissions/`, `security/`, or filename contains `credentials`, `oauth`, `jwt`, `session` |
| `"db-migration-switch"` | deletedFiles contain migration/schema tool files AND addedFiles contain different migration/schema tool files (e.g., prisma→drizzle) |
| `"feature-removal"` | 3+ non-test non-doc files deleted from same directory |

**Tier 1 triggers:**

| Category | Detection |
|----------|-----------|
| `"dependency-addition"` | `package.json` in changedFiles — hook.ts parses content diff to detect new deps in dependencies/devDependencies |
| `"dependency-removal"` | `package.json` in changedFiles — hook.ts parses content diff to detect removed deps |
| `"dependency-change"` | `package.json` in changedFiles but no dependency add/remove detected (script change, version bump, etc.) — classify as Tier 1 only if other structural signals present, otherwise IGNORE |
| `"env-var-change"` | `.env.example` or `.env.local.example` in changedFiles |
| `"new-directory"` | addedFiles have 2+ files sharing a parent directory that has no files in changedFiles (only added) |
| `"file-deletion"` | deletedFiles has non-test non-doc files (and not already caught by Tier 2 feature-removal) |
| `"config-change"` | Any file matching `/tsconfig|eslint|\.prettierrc|jest\.config|vitest\.config|\.github\/workflows/` |
| `"api-route-change"` | Any file matching `src/app/api/`, `src/pages/api/`, `src/routes/`, or new `page.tsx`/`page.ts` in a route directory |
| `"schema-change"` | Any file matching `schema`, `migration`, `.prisma`, `.sql`, `drizzle` |

**Grouping logic:**
1. First classify ALL files into their categories (a file may match multiple)
2. For each category, group files by nearest common ancestor directory
3. Emit one ClassifyResult per (category, directory-group) pair
4. Sort and deduplicate `changed_files` within each result
5. **Cap at 3 results per commit.** Priority: Tier 2 first, then Tier 1 sorted by structural signal strength (more files = stronger signal). If items are dropped, log to stderr: `[context-ledger] Capped at 3 inbox items (dropped N lower-priority classifications)`

### Validation Gate

```bash
npx tsc --noEmit 2>&1 | head -20
# Expected: errors only in hook.ts and index.ts (stubs importing from classify)
# classify.ts itself should compile clean
```

### STOP AND REPORT
Show: (1) ClassifyResult type definition, (2) Number of Tier 1 categories, (3) Number of Tier 2 categories, (4) Compile errors remaining.

---

## Phase 2: Post-Commit Hook (src/capture/hook.ts)

### What to build
The hook entry point. Gets git diff metadata, classifies, redacts, and appends inbox items. Must complete under 100ms. Never blocks a git commit. All output to stderr.

### File: `src/capture/hook.ts`

Replace the 2-line stub entirely.

### Exports

```typescript
export async function postCommit(): Promise<void>
```

### Imports

```typescript
import { execSync } from "node:child_process";
import type { InboxItem, FoldedDecision } from "../ledger/index.js";
import { generateInboxId, appendToInbox, foldLedger } from "../ledger/index.js";
import type { LedgerConfig } from "../config.js";
import { loadConfig } from "../config.js";
import { deriveScope } from "../retrieval/index.js";
import { classifyCommit } from "./classify.js";
import type { ClassifyResult, ParsedPackageJson } from "./classify.js";
```

### Helper: buildInboxItem

Centralize InboxItem construction to prevent schema drift (Council fix I2):

```typescript
function buildInboxItem(
  result: ClassifyResult,
  sha: string,
  redactedMessage: string,
  diffSummary: string,
  config: LedgerConfig,
): InboxItem {
  return {
    inbox_id: generateInboxId(),
    type: result.inbox_type,
    created: new Date().toISOString(),
    commit_sha: sha,
    commit_message: redactedMessage,
    change_category: result.change_category,
    changed_files: [...result.changed_files].sort(),
    diff_summary: diffSummary,
    priority: "normal",
    expires_after: new Date(Date.now() + config.capture.inbox_ttl_days * 24 * 60 * 60 * 1000).toISOString(),
    times_shown: 0,
    last_prompted_at: null,
    status: "pending",
  };
}
```

### Helper: redact

```typescript
function redact(text: string, patterns: string[]): string {
  let result = text;
  for (const pat of patterns) {
    try {
      result = result.replace(new RegExp(pat, "g"), "[REDACTED]");
    } catch { /* invalid regex — skip */ }
  }
  return result;
}
```

### Helper: buildDiffSummary

Build a brief human-readable summary. For package.json and .env.example, extract specific facts (dep names, env var names). For everything else, category + file counts.

```typescript
function buildDiffSummary(result: ClassifyResult, extras?: { packageJsonDiff?: ParsedPackageJson | null; envVarChanges?: string[] | null }): string {
  // Specific facts for the two most common structural changes
  if (result.change_category === "dependency-addition" && extras?.packageJsonDiff?.addedDeps.length) {
    return `dependency-addition: +${extras.packageJsonDiff.addedDeps.join(", +")}`;
  }
  if (result.change_category === "dependency-removal" && extras?.packageJsonDiff?.removedDeps.length) {
    return `dependency-removal: -${extras.packageJsonDiff.removedDeps.join(", -")}`;
  }
  if (result.change_category === "env-var-change" && extras?.envVarChanges?.length) {
    return `env-var-change: ${extras.envVarChanges.join(", ")}`;
  }

  // Generic: category + file counts
  const files = result.changed_files;
  if (files.length === 1) return `${result.change_category}: ${files[0]}`;
  const dirs = [...new Set(files.map(f => f.split("/").slice(0, -1).join("/")))];
  if (dirs.length === 1) return `${result.change_category}: ${files.length} files in ${dirs[0]}/`;
  return `${result.change_category}: ${files.length} files across ${dirs.length} directories`;
}
```

### Helper: parsePackageJsonDiff

Parse `git show` output to detect dependency additions/removals (~20ms, worth it for accuracy):

```typescript
function parsePackageJsonDiff(projectRoot: string): ParsedPackageJson | null {
  try {
    const current = JSON.parse(execSync("git show HEAD:package.json", { cwd: projectRoot, encoding: "utf8", stdio: "pipe" }));
    let previous: any = {};
    try {
      previous = JSON.parse(execSync("git show HEAD~1:package.json", { cwd: projectRoot, encoding: "utf8", stdio: "pipe" }));
    } catch { /* initial commit or file didn't exist */ }

    const currentDeps = { ...current.dependencies, ...current.devDependencies };
    const prevDeps = { ...previous.dependencies, ...previous.devDependencies };

    const addedDeps: string[] = [];
    const removedDeps: string[] = [];

    for (const [name, version] of Object.entries(currentDeps)) {
      if (!(name in prevDeps)) addedDeps.push(`${name}@${version}`);
    }
    for (const name of Object.keys(prevDeps)) {
      if (!(name in currentDeps)) removedDeps.push(name);
    }

    const otherChanges = JSON.stringify(current) !== JSON.stringify(previous) && addedDeps.length === 0 && removedDeps.length === 0;
    return { addedDeps, removedDeps, otherChanges };
  } catch {
    return null;
  }
}
```

### Helper: parseEnvChanges

Parse .env.example diff to extract changed variable names (~5ms):

```typescript
function parseEnvChanges(projectRoot: string): string[] | null {
  try {
    const current = execSync("git show HEAD:.env.example", { cwd: projectRoot, encoding: "utf8", stdio: "pipe" });
    let previous = "";
    try {
      previous = execSync("git show HEAD~1:.env.example", { cwd: projectRoot, encoding: "utf8", stdio: "pipe" });
    } catch { /* file didn't exist before */ }

    const parseVars = (text: string) => text.split("\n").filter(l => l.includes("=") && !l.startsWith("#")).map(l => l.split("=")[0].trim());
    const currentVars = new Set(parseVars(current));
    const prevVars = new Set(parseVars(previous));

    const changes: string[] = [];
    for (const v of currentVars) if (!prevVars.has(v)) changes.push(`+${v}`);
    for (const v of prevVars) if (!currentVars.has(v)) changes.push(`-${v}`);
    return changes.length > 0 ? changes : null;
  } catch {
    return null;
  }
}
```

### Helper: isMergeCommit

```typescript
function isMergeCommit(projectRoot: string): boolean {
  try {
    execSync("git rev-parse HEAD^2", { cwd: projectRoot, encoding: "utf8", stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}
```

### Helper: parseNameStatus

Parse `git diff-tree -z --name-status` output into categorized file arrays (Council fix I1):

```typescript
interface ParsedDiff {
  all: string[];
  added: string[];
  deleted: string[];
  modified: string[];
  renamed: Array<{ from: string; to: string }>;
}

function parseNameStatus(raw: string): ParsedDiff {
  const result: ParsedDiff = { all: [], added: [], deleted: [], modified: [], renamed: [] };
  // NUL-delimited: status\0path\0 (or status\0oldpath\0newpath\0 for renames)
  const parts = raw.split("\0").filter(Boolean);
  let i = 0;
  while (i < parts.length) {
    const status = parts[i];
    if (status.startsWith("R")) {
      const from = parts[i + 1] ?? "";
      const to = parts[i + 2] ?? "";
      result.renamed.push({ from, to });
      result.all.push(to);
      i += 3;
    } else {
      const path = parts[i + 1] ?? "";
      result.all.push(path);
      if (status === "A") result.added.push(path);
      else if (status === "D") result.deleted.push(path);
      else if (status === "M") result.modified.push(path);
      i += 2;
    }
  }
  return result;
}
```

### Module-level debug flag

```typescript
const DEBUG = !!process.env.CONTEXT_LEDGER_DEBUG;
function debug(msg: string): void { if (DEBUG) console.error(`[context-ledger] ${msg}`); }
```

### Implementation Steps (CORRECTED ORDER per Council + Human Input)

**1. Resolve projectRoot:**
```typescript
const projectRoot = process.env.CONTEXT_LEDGER_PROJECT_ROOT ?? process.cwd();
debug(`projectRoot: ${projectRoot}`);
```

**2. Load config + check enabled:**
```typescript
const config = await loadConfig(projectRoot);
if (!config.capture.enabled) { debug("capture disabled"); return; }
```

**3. Get commit message FIRST (for early exit — Council fix I4):**
```typescript
const sha = execSync("git rev-parse HEAD", { cwd: projectRoot, encoding: "utf8", stdio: "pipe" }).trim();
const subject = execSync("git log -1 --format=%s HEAD", { cwd: projectRoot, encoding: "utf8", stdio: "pipe" }).trim();
const fullBody = execSync("git log -1 --format=%B HEAD", { cwd: projectRoot, encoding: "utf8", stdio: "pipe" }).trim();
```

**4. Check no_capture_marker in FULL BODY (Council fix S2):**
```typescript
if (fullBody.includes(config.capture.no_capture_marker)) return;
```

**5. Skip merge commits (Council fix D5):**
```typescript
if (isMergeCommit(projectRoot)) return;
```

**6. Get changed files via single consolidated git command (Council fix I1):**
```typescript
let raw: string;
try {
  raw = execSync("git diff-tree --root -r --name-status -z HEAD", { cwd: projectRoot, encoding: "utf8", stdio: "pipe" });
} catch {
  return; // git command failed — silently exit
}
const diff = parseNameStatus(raw);
if (diff.all.length === 0) return; // empty commit (Council fix S9)
```

**7. Normalize all paths immediately (Council fix S7):**
Apply `normalizePath()` (or inline equivalent) to all file arrays before any classification or filtering.

**8. Parse high-value file diffs + Classify:**
```typescript
// Parse package.json diff for accurate dependency detection (~20ms, worth it)
const pkgDiff = diff.all.some(f => f.endsWith("package.json"))
  ? parsePackageJsonDiff(projectRoot)
  : null;

// Parse .env.example for variable names
const envChanges = diff.all.some(f => f.includes(".env"))
  ? parseEnvChanges(projectRoot)
  : null;

const results = classifyCommit(diff.all, diff.deleted, diff.added, subject, config, pkgDiff);
if (results.length === 0) { debug("no actionable classifications"); return; }
debug(`classified: ${results.length} results`);
```

**9. Tier 2 contradiction detection — BEST EFFORT with inner try/catch (Council fixes C3, C5, S6):**

Only attempt if:
- `.context-ledger/ledger.jsonl` exists
- File size is under 100KB (performance gate)

```typescript
try {
  const stats = await stat(ledgerPath(projectRoot)).catch(() => null);
  if (stats && stats.size < 100 * 1024) {
    const state = await foldLedger(projectRoot);
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (r.tier === 1) {
        // Check if any changed file maps to a scope with an active decision
        for (const f of r.changed_files) {
          const derived = deriveScope({ file_path: f }, config, state.decisions);
          if (derived) {
            // Check for active decisions in this scope
            for (const [, folded] of state.decisions) {
              if (folded.state === "active" &&
                  folded.record.scope.type === derived.type &&
                  folded.record.scope.id === derived.id) {
                // Upgrade to Tier 2
                results[i] = {
                  tier: 2,
                  change_category: "contradicts-active-decision",
                  inbox_type: "question_needed",
                  changed_files: r.changed_files,
                };
                break;
              }
            }
          }
          if (results[i].tier === 2) break; // already upgraded
        }
      }
    }
  }
} catch {
  // Tier 2 detection failed — continue with Tier 1 results only
  if (process.env.CONTEXT_LEDGER_DEBUG) {
    console.error("[context-ledger] Tier 2 contradiction detection failed, continuing with Tier 1");
  }
}
```

**10. Build diff_summary FIRST, then redact BOTH (Council fix C1):**
```typescript
const redactedMessage = redact(subject, config.capture.redact_patterns);
const extras = { packageJsonDiff: pkgDiff, envVarChanges: envChanges };

for (const result of results) {
  const rawSummary = buildDiffSummary(result, extras);
  const redactedSummary = redact(rawSummary, config.capture.redact_patterns);
  const item = buildInboxItem(result, sha, redactedMessage, redactedSummary, config);
  await appendToInbox(item, projectRoot);
  console.error(`[context-ledger] Captured ${result.change_category} (${result.inbox_type})`);
}
```

**11. Wrap entire function in try/catch:**
```typescript
export async function postCommit(): Promise<void> {
  try {
    // ... all the above ...
  } catch (err: any) {
    debug(`Hook error (non-fatal): ${err.message}`);
    // Never throw — never block git commit
  }
}
```

**12. Self-invocation guard at module level:**
```typescript
const isDirectRun = process.argv[1]?.endsWith("hook.js") || process.argv[1]?.endsWith("hook.ts");
if (isDirectRun) {
  postCommit().catch(() => {});
}
```

### Additional imports needed:
```typescript
import { stat } from "node:fs/promises";
import { ledgerPath } from "../ledger/index.js";
```

Note: `ParsedPackageJson` type is imported from `./classify.js` (defined there alongside ClassifyResult).

### Validation Gate

```bash
npx tsc --noEmit 2>&1 | head -20
# Expected: errors only in index.ts (barrel not yet updated)
# hook.ts should compile clean

# Verify no console.log usage
grep -n "console.log" src/capture/hook.ts
# Expected: 0 matches

# Verify no rewriteInbox usage
grep -n "rewriteInbox" src/capture/hook.ts
# Expected: 0 matches
```

### STOP AND REPORT
Show: (1) Hook entry point signature, (2) Git command count (should be 3-4 total: rev-parse, log subject, log body, diff-tree), (3) Redaction order confirmed correct, (4) Compile errors remaining.

---

## Phase 3: Barrel Exports (src/capture/index.ts)

### File: `src/capture/index.ts`

Replace the 2-line stub:

```typescript
// context-ledger — capture barrel exports
export type { ClassifyResult } from "./classify.js";
export { classifyCommit } from "./classify.js";
export { postCommit } from "./hook.js";
```

### Validation Gate

```bash
npx tsc --noEmit 2>&1 | head -20
# Expected: ZERO errors — all three files compile clean
```

### STOP AND REPORT
Show: compile result (0 errors expected).

---

## Phase 4: package.json Script

### Edit: `package.json`

Add to the `"scripts"` section:

```json
"postcommit": "node dist/capture/hook.js"
```

### Validation Gate

```bash
# Full build
npm run build
# Expected: ZERO errors
```

### STOP AND REPORT
Show: build result.

---

## Phase 5: Documentation Sync

```bash
npx agent-guard sync
```

Review changes to `docs/ARCHITECTURE.md` and any other files. Stage if correct.

### STOP AND REPORT
Show: files modified by agent-guard.

---

## Phase 6: Final Validation

### Build

```bash
npm run build
# MUST pass with ZERO errors
```

### Manual Smoke Test

```bash
# Run the hook directly (will use current HEAD):
node dist/capture/hook.js
# Should print something to stderr or silently exit 0

# Check if .context-ledger/inbox.jsonl has new entries (if any structural changes in current HEAD)
cat .context-ledger/inbox.jsonl 2>/dev/null | tail -3
```

### Code Quality Checks

```bash
# No console.log in capture files (only console.error)
grep -rn "console.log" src/capture/
# Expected: 0 matches

# All imports use .js extensions
grep -rn 'from "\.\.' src/capture/ | grep -v '\.js"'
# Expected: 0 matches (all imports end in .js)

# No network calls
grep -rn "fetch\|http\|https\|axios\|node-fetch" src/capture/
# Expected: 0 matches

# Append-only — no rewriteInbox usage
grep -rn "rewriteInbox" src/capture/
# Expected: 0 matches
```

### STOP AND REPORT
Show: build result, smoke test output, all quality checks.

---

## Human Input Applied (Bucket 2 Answers)

| Q | Decision | Impact |
|---|----------|--------|
| Q1 | Extract facts for package.json and .env.example; category + file counts for everything else | Added parsePackageJsonDiff, parseEnvChanges helpers; enhanced buildDiffSummary |
| Q2 | Parse package.json content diff. Distinguish dependency-add/remove from script changes | Added ParsedPackageJson type, parsePackageJsonDiff helper, split dependency-change into -addition/-removal |
| Q3 | Cap at 3 inbox items per commit. Tier 2 first, then Tier 1 by file count | Added cap logic to grouping step in classify.ts, log dropped items to stderr |
| Q4 | Skip merge commits entirely | Added isMergeCommit helper, early return in hook |
| Q5 | No amend dedup. TTL and max-prompts handle it | No change needed |
| Q6 | Add CONTEXT_LEDGER_DEBUG env var | Added module-level DEBUG flag and debug() helper |

## Refinement Log (Council Fixes Applied)

| ID | Fix | Source |
|----|-----|--------|
| C1 | Redaction order: build diff_summary FIRST, then redact both message and summary | Both |
| C2 | Use `git diff-tree --root -r` for initial commit safety; skip merge commits | Both |
| C3 | Gate foldLedger behind file size check (<100KB); inner try/catch | Both |
| C5 | Specify Tier 2 contradiction: deriveScope → check active decisions → upgrade | OpenAI |
| S1 | ClassifyResult has no null fields — only actionable results returned | OpenAI |
| S2 | Check full commit body (`%B`) for no_capture_marker, store subject in commit_message | OpenAI |
| S6 | Inner try/catch around Tier 2 detection; Tier 1 continues on failure | OpenAI |
| S7 | Normalize all paths immediately after git parsing | OpenAI |
| S9 | Handle empty commits (diff.all.length === 0 → return) | Gemini |
| I1 | Single `git diff-tree -z --root -r --name-status HEAD` instead of 3 calls | Both |
| I2 | buildInboxItem helper centralizes construction | OpenAI |
| I3 | Sort and dedupe changed_files in buildInboxItem | OpenAI |
| I4 | Check no_capture_marker before running diff-tree | Gemini |
| S8 | CONTEXT_LEDGER_DEBUG env var for verbose stderr | Gemini |

---

## Summary

| Phase | File | Action |
|-------|------|--------|
| 1 | `src/capture/classify.ts` | Deterministic classifier: 8 Tier 1 + 4 Tier 2 categories + package.json parsing support |
| 2 | `src/capture/hook.ts` | Post-commit entry: git → parse pkg/env → classify → contradiction check → redact → append (3-item cap) |
| 3 | `src/capture/index.ts` | Barrel exports |
| 4 | `package.json` | Add `postcommit` script |
| 5 | docs | agent-guard sync |
| 6 | — | Build + smoke test + quality checks |
