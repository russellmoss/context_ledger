# Agentic Implementation Guide — Interactive Setup Wizard (src/setup.ts)

**Feature:** Interactive setup wizard using @clack/prompts for project onboarding
**Spec:** context-ledger-design-v2.md (Setup Wizard section, lines 807-842)
**Exploration:** exploration-results.md, code-inspector-findings.md, pattern-finder-findings.md

---

## Critical Rules (read before every phase)

- All imports use `.js` extensions for internal modules. External packages (`@clack/prompts`) do not.
- Config writes: `JSON.stringify(config, null, 2) + "\n"` — pretty-printed, trailing newline
- **MANDATORY**: Every @clack/prompts prompt return value MUST be checked with `isCancel()` immediately after the await. If cancelled, call `cancel("Setup cancelled.")` and `return`. Treat this as a compile-time rule — never use a prompt result without checking first.
- Hook script uses scoped package name `@mossrussell/context-ledger`
- Inside setup.ts, prefer @clack/prompts `log.*` and `note()` over raw `console.log`/`console.error`
- Standing instructions snippet is the EXACT text from design spec lines 553-576 — do not paraphrase
- **MANDATORY**: `loadConfig()` returns the shared `DEFAULT_CONFIG` singleton on ENOENT. You MUST deep-clone before mutating: `structuredClone(await loadConfig(projectRoot))`. Failure to clone will corrupt defaults for the process.
- **MANDATORY**: All file paths used as config keys (scope_mappings) must use forward slashes and end with a trailing slash. Normalize with `.split("\\").join("/")` on all platforms.

---

## Phase 1: Implement src/setup.ts

### Goal
Replace the 3-line placeholder in `src/setup.ts` with a complete interactive wizard.

### File: `src/setup.ts`

The file must follow the standalone binary entry point pattern (from `src/mcp-server-bin.ts`):

```typescript
#!/usr/bin/env node
// context-ledger — interactive setup wizard
```

### Imports needed:

```typescript
import { readFile, writeFile, readdir, access, mkdir } from "node:fs/promises";
import { join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import {
  intro, outro, cancel, note, log,
  confirm, multiselect, spinner, isCancel,
} from "@clack/prompts";
import { DEFAULT_CONFIG, loadConfig } from "./config.js";
import type { LedgerConfig, ScopeMapping } from "./config.js";
import type { ScopeType } from "./ledger/index.js";
import { ledgerDir, configPath } from "./ledger/index.js";
import { queryDecisions } from "./retrieval/index.js";
```

### Export:

```typescript
export async function runSetupWizard(projectRoot: string): Promise<void>
```

This is the main entry. Called by both the `context-ledger-setup` binary and `cli.ts handleSetup()`.

### Self-invocation (bottom of file):

**Council fix S9**: Use `import.meta.url` for reliable direct-run detection instead of `process.argv[1].endsWith()`:

```typescript
const isDirectRun = process.argv[1] === fileURLToPath(import.meta.url);
if (isDirectRun) {
  const projectRoot = process.env.CONTEXT_LEDGER_PROJECT_ROOT ?? process.cwd();
  runSetupWizard(projectRoot).catch((err) => {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  });
}
```

### Helper: Path normalization

**Council fix C4**: All paths used as config keys must be POSIX with trailing slash:

```typescript
function toPosixKey(p: string): string {
  const normalized = p.split("\\").join("/");
  return normalized.endsWith("/") ? normalized : normalized + "/";
}
```

### Helper: Cancel guard

**Council fix C1**: Create a reusable cancel check to reduce boilerplate:

```typescript
function guardCancel<T>(value: T | symbol): T {
  if (isCancel(value)) {
    cancel("Setup cancelled.");
    process.exit(0);
  }
  return value;
}
```

Use after every prompt: `const result = guardCancel(await confirm({ ... }));`

### Step 1: Project Detection

```typescript
intro("context-ledger setup");
```

Read `package.json` for project name and detect tech stack:
- Check `dependencies` / `devDependencies` for framework indicators (next, react, express, etc.)
- Check for `typescript` in devDependencies

Check existence of:
- `.claude/` directory
- `agent-docs.config.json` (agent-guard indicator)
- `.claude/settings.local.json` — if exists, read content and check for `"council"` string (council-mcp indicator)

Build a summary array and display with `note()`:
```
✓ Project: my-project (TypeScript)
✓ agent-guard detected
✗ council-mcp not found
✓ .claude/ directory exists
```

Use `log.info()` for individual detection messages. Wrap each check in try/catch — if one fails, show ✗ and continue.

### Step 2: Scope Mapping Generation

**Council fix S1**: First check if source directory exists. Try `src/` first, then `app/`, `lib/`. If none found, skip with `log.warn("No source directory found. Skipping scope mapping generation.")` and continue to Step 3.

Scan the found source directory 2 levels deep using `readdir({ withFileTypes: true })`.

**Council fix S6**: Sort discovered directories alphabetically before presenting.

For each directory found, generate a suggested scope mapping:
- Path key: `toPosixKey(relative path)` — e.g., `src/auth/`
- ScopeMapping value: `{ type: ScopeType, id: string }`

Heuristic for scope type:
- Directories named `lib`, `utils`, `helpers`, `shared`, `common` → type: `"concern"`
- All others → type: `"domain"` (safe default)

**Council fix S5**: If no directories found, skip multiselect and log info. Otherwise present:
```typescript
const suggestions = [...]; // sorted alphabetically
if (suggestions.length === 0) {
  log.info("No directories found for scope mapping.");
} else {
  const selectedMappings = guardCancel(await multiselect({
    message: "Which scope mappings should be created?",
    options: suggestions.map(s => ({
      value: s.path,
      label: `${s.path} → ${s.type}/${s.id}`,
    })),
    initialValues: suggestions.map(s => s.path),
    required: false,
  }));
  // ... write config
}
```

Also generate `feature_hint_mappings` from selected directory basenames:
- `src/auth/` → `{ "auth": ["auth"] }`
- `src/ledger/` → `{ "ledger": ["ledger"] }`

Simple strategy: use the directory basename as both the keyword and the scope ID.

**Council fix C2**: Deep-clone config before mutating:
```typescript
const config = structuredClone(await loadConfig(projectRoot));
```

**Council fix S11**: Additive merge — only add keys that don't already exist:
```typescript
for (const path of selectedMappings) {
  const suggestion = suggestions.find(s => s.path === path);
  if (suggestion && !(suggestion.path in config.capture.scope_mappings)) {
    config.capture.scope_mappings[suggestion.path] = { type: suggestion.type as ScopeType, id: suggestion.id };
  }
}
// Same for feature_hint_mappings — only add new keys
for (const [keyword, scopeIds] of Object.entries(newHintMappings)) {
  if (!(keyword in config.retrieval.feature_hint_mappings)) {
    config.retrieval.feature_hint_mappings[keyword] = scopeIds;
  }
}
```

**Council fix C3**: Ensure directory exists before writing:
```typescript
await mkdir(ledgerDir(projectRoot), { recursive: true });
await writeFile(configPath(projectRoot), JSON.stringify(config, null, 2) + "\n", "utf8");
```

### Step 3: Hook Installation

**Council fix S10**: First check if `.git/` exists at all:
```typescript
try {
  await access(join(projectRoot, ".git"));
} catch {
  log.warn("No git repository found. Run 'git init' first, then re-run setup to install hooks.");
  // skip entire step
  return; // (from step try/catch, not wizard)
}
```

**Council fix C5 (Bucket 2 resolved)**: Use the shared `detectHookSystem()` from `src/capture/detect-hooks.ts` (see Phase 1b below) instead of reimplementing detection logic:

```typescript
import { detectHookSystem } from "./capture/detect-hooks.js";
// ...
const hookSystem = await detectHookSystem(projectRoot);
log.info(`Detected hook system: ${hookSystem.system}`);
```

The detection function returns `{ system, path? }`. The setup wizard then handles installation UI with @clack/prompts based on the detected system.

Hook script template (EXACT — from cli.ts lines 401-405):
```
#!/bin/sh
# context-ledger post-commit hook
# Instantaneous, deterministic — zero LLM calls, zero network calls.
node -e "import('@mossrussell/context-ledger/dist/capture/hook.js').then(m => m.postCommit()).catch(() => {})" 2>/dev/null || true
```

Marker for idempotency: `"context-ledger"` (used in `includes()` check on existing hook content)

For Husky and bare hooks:
1. Show what will be done with `log.info()`
2. `const proceed = guardCancel(await confirm({ message: "Install post-commit hook?" }));`
3. If confirmed, apply the hook:
   - If hook file exists and contains marker → skip, `log.success("Hook already installed.")`
   - If hook file exists and does NOT contain marker → append with `"\n\n"` separator, `{ mode: 0o755 }`
   - If hook file does not exist → create with `{ mode: 0o755 }`

For Lefthook and simple-git-hooks: show manual instructions via `note()`.

If no hook system found, show a warning with `log.warn("Could not detect a hook system. Install one (Husky, Lefthook) or run 'git init'.")`.

### Step 4: Standing Instructions Injection

**Council fix S3 (Bucket 2 resolved)**: CLAUDE.md is the primary and only injection target. If both CLAUDE.md and .cursorrules exist, inject into CLAUDE.md only. Log that .cursorrules was found but CLAUDE.md was used.

Detection logic:
```typescript
const claudeMdPath = join(projectRoot, "CLAUDE.md");
const cursorrulesPath = join(projectRoot, ".cursorrules");
let targetPath: string | null = null;

try {
  await access(claudeMdPath);
  targetPath = claudeMdPath;
  // Check if .cursorrules also exists — log note
  try {
    await access(cursorrulesPath);
    log.info("Found both CLAUDE.md and .cursorrules — using CLAUDE.md as primary target.");
  } catch { /* only CLAUDE.md exists, fine */ }
} catch {
  try {
    await access(cursorrulesPath);
    targetPath = cursorrulesPath;
  } catch {
    targetPath = null; // neither exists
  }
}
```

**Council fix S4**: Use `## context-ledger Integration` heading as the idempotency marker:

```typescript
const STANDING_INSTRUCTIONS_MARKER = "## context-ledger Integration";
```

If target file exists, read it. If marker heading found, skip: `log.success("Standing instructions already present.")`.

**Council fix S2**: If neither CLAUDE.md nor .cursorrules exists, offer to CREATE CLAUDE.md:
```typescript
if (!targetPath) {
  const createIt = guardCancel(await confirm({
    message: "No CLAUDE.md or .cursorrules found. Create CLAUDE.md with context-ledger instructions?",
  }));
  if (createIt) {
    await writeFile(claudeMdPath, snippet + "\n", "utf8");
    instructionsInjected = true;
  }
  // skip rest of step 4
}
```

**Council fix S8**: If agent-guard block exists, find its section boundary:
```typescript
// Search for agent-guard heading
const agentGuardMatch = existing.match(/^##?\s+.*agent-guard.*/im);
if (agentGuardMatch) {
  // Find the next heading of same or higher level after agent-guard
  const agentGuardPos = existing.indexOf(agentGuardMatch[0]);
  const afterAgentGuard = existing.slice(agentGuardPos + agentGuardMatch[0].length);
  const nextHeadingMatch = afterAgentGuard.match(/\n##?\s+/m);
  if (nextHeadingMatch) {
    // Insert before the next heading
    const insertPos = agentGuardPos + agentGuardMatch[0].length + nextHeadingMatch.index!;
    const updated = existing.slice(0, insertPos) + "\n" + snippet + "\n" + existing.slice(insertPos);
  } else {
    // No next heading — append to end
    const updated = existing.trimEnd() + "\n\n" + snippet + "\n";
  }
} else {
  // No agent-guard block — append to end
  const updated = existing.trimEnd() + "\n\n" + snippet + "\n";
}
```

Standing instructions snippet (EXACT text from design spec lines 553-576):

```markdown

## context-ledger Integration

At session start (for non-/auto-feature sessions):
- Check inbox.jsonl for pending items (max 3 per session). Present Tier 2 (must-ask) first.
- Note: /auto-feature handles inbox checks automatically as its first step.

Before modifying architectural patterns, adding/removing dependencies, creating new directories,
or changing established conventions:
- Use query_decisions with the relevant file path (primary) or scope
- If a trusted precedent exists (retrieval_weight >= 0.7, durability = precedent, status = active),
  follow it and cite the decision ID
- If no precedent exists and the choice is ambiguous, flag it as a Bucket 2 question
- If diverging from a precedent, use supersede_decision with rationale and pain_points

After answering Phase 4 Bucket 2 questions:
- Classify each answer as precedent, feature-local, or temporary-workaround
- Use record_writeback for precedent-worthy answers only
- Temporary workarounds require a review_after date

For all MCP write tool calls, generate `client_operation_id` using the pattern:
`{feature-slug}-{YYYYMMDD}-{random4chars}` (e.g., `sqo-export-20260401-a3f2`).
Never reuse operation IDs across calls.
```

Show the snippet to user with `note(snippet, "Standing instructions to inject")`, then:
```typescript
const proceed = guardCancel(await confirm({ message: `Add to ${basename(targetPath)}?` }));
```

### Step 5: First-Run Demo

**Council fix C6**: Use `queryDecisions()` directly instead of raw `readLedger()`. This properly materializes state and returns only active decisions:

```typescript
try {
  const pack = await queryDecisions({ query: "architecture" }, projectRoot);
  
  if (pack.active_precedents.length > 0) {
    // Format real decision pack
    const lines = [
      `Active Precedents: ${pack.active_precedents.length}`,
      ...pack.active_precedents.slice(0, 5).map(p =>
        `  • [${p.record.id}] ${p.record.summary} (weight: ${p.retrieval_weight})`
      ),
      `Abandoned Approaches: ${pack.abandoned_approaches.length}`,
      `Pending Inbox Items: ${pack.pending_inbox_items.length}`,
      `Token Estimate: ${pack.token_estimate.toLocaleString()}`,
    ];
    note(lines.join("\n"), "Decision Pack Preview");
  } else {
    // Empty ledger — show example
    note(
      `Your ledger is empty — no decisions captured yet.\n\n` +
      `After your first few commits with the post-commit hook,\n` +
      `or after running 'context-ledger backfill', the decision\n` +
      `pack will start populating.\n\n` +
      `Example decision pack:\n` +
      `  Active Precedents: 3\n` +
      `  • Use COALESCE for null handling (weight: 0.9)\n` +
      `  • Prefer server components (weight: 0.85)\n` +
      `  Abandoned Approaches: 1\n` +
      `  Token Estimate: ~2,000`,
      "What Claude Code will see"
    );
  }
} catch {
  // Ledger doesn't exist yet — show example
  note(
    `Your ledger is empty — decisions will appear after your first commits.`,
    "First-Run Demo"
  );
}
```

### Outro

Track what was configured across steps using boolean flags set within each step's try/catch:

```typescript
let scopeMappingsWritten = false;
let scopeCount = 0;
let hookInstalled = false;
let instructionsInjected = false;
// ... set these within each step

const steps: string[] = [];
if (scopeMappingsWritten) steps.push(`${scopeCount} scope mappings configured`);
if (hookInstalled) steps.push("Post-commit hook installed");
if (instructionsInjected) steps.push("Standing instructions added");

outro(
  `Setup complete!\n\n` +
  (steps.length > 0 ? steps.map(s => `  ✓ ${s}`).join("\n") + "\n\n" : "") +
  `Next steps:\n` +
  `  • Run 'context-ledger backfill' to capture history from recent commits\n` +
  `  • Start making commits — the hook will capture decisions automatically\n` +
  `  • Use 'context-ledger query <topic>' to test retrieval`
);
```

### Error Handling

Each step is wrapped in its own try/catch. If a step fails:
```typescript
try {
  // step logic
} catch (err) {
  log.error(`Step N failed: ${err instanceof Error ? err.message : String(err)}`);
  log.info("Continuing to next step...");
}
```

The wizard continues to the next step even if one fails.

### Validation Gate

```bash
npx tsc --noEmit
# Must compile with zero errors

# Verify the export exists:
grep "export async function runSetupWizard" src/setup.ts

# Verify shebang:
head -1 src/setup.ts
# Expected: #!/usr/bin/env node

# Verify all @clack/prompts calls have isCancel checks (via guardCancel):
grep -c "guardCancel\|isCancel" src/setup.ts
# Should be >= number of prompt calls

# Verify structuredClone is used before config mutation:
grep "structuredClone" src/setup.ts
# Should show at least 1 match

# Verify path normalization:
grep "toPosixKey\|split.*join" src/setup.ts
# Should show normalization usage
```

### STOP AND REPORT
Confirm Phase 1 compiles before proceeding.

---

## Phase 1b: Extract hook detection into src/capture/detect-hooks.ts

### Goal
Extract hook system detection from `cli.ts installPostCommitHook()` into a shared module. Both `cli.ts` and `setup.ts` call the same detection function. Installation UI stays separate in each caller.

### New file: `src/capture/detect-hooks.ts`

```typescript
// context-ledger — shared hook system detection

import { readFile, access } from "node:fs/promises";
import { join } from "node:path";

export type HookSystem = "husky" | "lefthook" | "simple-git-hooks" | "bare" | "none";

export interface HookDetectionResult {
  system: HookSystem;
  /** Path to the hook file (for husky and bare) or config file (for lefthook) */
  hookPath: string | null;
  /** Whether the context-ledger hook is already installed */
  alreadyInstalled: boolean;
}

const MARKER = "context-ledger";

export async function detectHookSystem(projectRoot: string): Promise<HookDetectionResult> {
  // 1. Husky
  const huskyDir = join(projectRoot, ".husky");
  try {
    await access(huskyDir);
    const hookPath = join(huskyDir, "post-commit");
    const installed = await checkMarker(hookPath);
    return { system: "husky", hookPath, alreadyInstalled: installed };
  } catch { /* not husky */ }

  // 2. Lefthook
  const lefthookPath = join(projectRoot, "lefthook.yml");
  try {
    await access(lefthookPath);
    return { system: "lefthook", hookPath: lefthookPath, alreadyInstalled: false };
  } catch { /* not lefthook */ }

  // 3. simple-git-hooks
  try {
    const pkg = JSON.parse(await readFile(join(projectRoot, "package.json"), "utf8"));
    if (pkg["simple-git-hooks"]) {
      return { system: "simple-git-hooks", hookPath: null, alreadyInstalled: false };
    }
  } catch { /* ignore */ }

  // 4. Bare .git/hooks/
  const bareHookDir = join(projectRoot, ".git", "hooks");
  try {
    await access(bareHookDir);
    const hookPath = join(bareHookDir, "post-commit");
    const installed = await checkMarker(hookPath);
    return { system: "bare", hookPath, alreadyInstalled: installed };
  } catch { /* no .git/hooks */ }

  return { system: "none", hookPath: null, alreadyInstalled: false };
}

async function checkMarker(hookPath: string): Promise<boolean> {
  try {
    const content = await readFile(hookPath, "utf8");
    return content.includes(MARKER);
  } catch {
    return false; // file doesn't exist yet
  }
}
```

### Update `src/cli.ts installPostCommitHook()`

Replace the inline detection logic with a call to `detectHookSystem()`:
```typescript
import { detectHookSystem } from "./capture/detect-hooks.js";

async function installPostCommitHook(): Promise<void> {
  const hookScript = `...`; // (keep existing template)
  const marker = "context-ledger";
  const result = await detectHookSystem(projectRoot);

  switch (result.system) {
    case "husky": {
      // existing husky logic using result.hookPath
      break;
    }
    case "lefthook": {
      // existing lefthook instructions
      break;
    }
    case "simple-git-hooks": {
      // existing simple-git-hooks instructions
      break;
    }
    case "bare": {
      // existing bare hook logic using result.hookPath
      break;
    }
    case "none": {
      console.error("Warning: Could not find .git/hooks/ directory...");
      break;
    }
  }
}
```

The key change: detection is now shared, but each caller (cli.ts, setup.ts) handles the result with its own UI (console.log vs @clack/prompts).

### Update `src/setup.ts` Step 3

Import and use the shared detection:
```typescript
import { detectHookSystem } from "./capture/detect-hooks.js";
```

### Validation Gate

```bash
npx tsc --noEmit

# Verify shared detection is used in both files:
grep "detectHookSystem" src/cli.ts src/setup.ts
# Should show imports in both files

# Verify old inline detection in cli.ts is replaced:
grep -c "Check for Husky" src/cli.ts
# Should be 0 (comments removed with old code)
```

### STOP AND REPORT
Confirm Phase 1b compiles.

---

## Phase 2: Update cli.ts handleSetup()

### Goal
Replace the stub in `src/cli.ts` with a delegation to `runSetupWizard`.

### File: `src/cli.ts`

Add import at the top (as a NEW import line — `runSetupWizard` comes from `./setup.js`, not from an existing import):
```typescript
import { runSetupWizard } from "./setup.js";
```

Replace handleSetup() (currently at lines ~830-834):
```typescript
async function handleSetup(): Promise<void> {
  await runSetupWizard(projectRoot);
}
```

### Validation Gate

```bash
npx tsc --noEmit
# Must compile with zero errors

# Verify import:
grep "runSetupWizard" src/cli.ts
# Should show both the import line and the call

# Verify old stub is gone:
grep "Setup wizard is not yet implemented" src/cli.ts
# Should return no matches
```

### STOP AND REPORT
Confirm Phase 2 compiles.

---

## Phase 3: Build and Verify

### Goal
Full build pass and structural verification.

```bash
# Type check
npx tsc --noEmit

# Verify package.json bin entry matches (it should already be correct)
grep "context-ledger-setup" package.json

# Run agent-guard sync
npx agent-guard sync
```

### STOP AND REPORT
Report build status and any agent-guard doc changes.

---

## Phase 4: Integration Verification

### Goal
Verify the wizard can be invoked through both entry points.

```bash
# Direct binary (after tsc build)
npx tsc
node dist/setup.js --help 2>&1 || true
# Should show the wizard intro (or run interactively)

# Via CLI
node dist/cli.js setup --help 2>&1 || true
```

Note: Full interactive testing requires a terminal. The validation here is that both entry points resolve without import errors.

### STOP AND REPORT
Report final status. Suggest commit message.

---

## Files Modified Summary

| File | Lines Changed (est.) | Change Description |
|------|---------------------|-------------------|
| `src/setup.ts` | ~400 new | Complete wizard implementation with council fixes |
| `src/capture/detect-hooks.ts` | ~60 new | Shared hook system detection |
| `src/cli.ts` | ~30 changed | Import detectHookSystem, delegate handleSetup, refactor installPostCommitHook |

## Dependencies

- `@clack/prompts ^1.2.0` — already in package.json, no installation needed
- No new dependencies required

## What This Guide Does NOT Cover

- Guided backfill flow (separate feature, design spec lines 827-842)
- Unit tests for the wizard (interactive prompts are hard to test — integration test recommended)
- Windows-specific hook permission handling (mode 0o755 is a no-op on Windows but not harmful)

---

## Refinement Log

### Council Review Applied (Bucket 1)

| ID | Fix Applied |
|----|------------|
| C1 | Added `guardCancel()` helper + mandatory isCancel pattern in Critical Rules |
| C2 | Added `structuredClone()` before config mutation + warning in Critical Rules |
| C3 | Verified mkdir already in guide, made more prominent |
| C4 | Added `toPosixKey()` helper + path normalization rule in Critical Rules |
| C6 | Replaced `readLedger()` with `queryDecisions()` in Step 5 |
| C7 | Explicit `{ query: "architecture" }` params in Step 5 |
| S1 | Added src/ existence check with fallback to app/, lib/ |
| S2 | Added CLAUDE.md creation offer when neither file exists |
| S4 | Changed marker from `"context-ledger"` to `## context-ledger Integration` |
| S5 | Added empty suggestions check before multiselect |
| S6 | Added alphabetical sort of directory suggestions |
| S7 | Added additive merge strategy for feature_hint_mappings |
| S8 | Added agent-guard heading detection with section boundary logic |
| S9 | Replaced endsWith check with import.meta.url comparison |
| S10 | Added .git existence check before hook installation |
| S11 | Added additive-only config merge (skip existing keys) |

### Bucket 2 — Resolved

| ID | Decision |
|----|----------|
| C5 | **Extract hook detection** into `src/capture/detect-hooks.ts`. Both `cli.ts` and `setup.ts` call the same detection function. Installation UI stays separate in each caller. |
| S3 | **CLAUDE.md only**. If both CLAUDE.md and .cursorrules exist, inject into CLAUDE.md. Log a note that .cursorrules was found but CLAUDE.md was used as the primary target. |
