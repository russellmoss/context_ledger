# Pattern Finder Findings — context-ledger Setup Wizard

Generated: 2026-04-01
Purpose: Document implementation patterns for building src/setup.ts using @clack/prompts.

---

## 1. CLI Command Pattern

### Entry Point

`/Users/russe/documents/context_ledger/src/cli.ts` lines 1-841

### Key Patterns

**Project root resolution** (line 31) — single top-level constant:

```typescript
const projectRoot = process.env.CONTEXT_LEDGER_PROJECT_ROOT ?? process.cwd();
```

Every command receives projectRoot from this constant. The setup wizard must use the same pattern.

**Arg parsing helpers** (lines 36-46):

```typescript
function getFlag(flag: string): string | undefined { ... }
function hasFlag(flag: string): boolean {
  return args.includes(flag);
}
```

Handles both `--flag value` and `--flag=value` forms. The wizard receives no flags.

**Command dispatch** (lines 68-87):

```typescript
switch (command) {
  case "init": return handleInit();
  case "setup": return handleSetup();
  ...
}
```

**Pre-flight check**: Commands in `NEEDS_LEDGER` abort if `.context-ledger/` does not exist. `setup` is NOT in this set — the wizard runs before `init`.

**Error output rule**: All errors go to `console.error`. `console.log` is for user-facing output. In `src/index.ts` (MCP binary), `console.log` is forbidden — stdout is reserved for JSON-RPC.

**Module imports** (lines 5-27): All internal imports use `.js` extensions even in TypeScript source:

```typescript
import { DEFAULT_CONFIG, loadConfig } from "./config.js";
import { readLedger, readInbox, ... } from "./ledger/index.js";
```

**handleSetup stub** (lines 830-834): Currently a stub — `src/setup.ts` replaces this via the `context-ledger-setup` binary:

```typescript
async function handleSetup(): Promise<void> {
  console.error("Setup wizard is not yet implemented.");
  process.exit(1);
}
```

**Top-level error handler** (lines 838-840):

```typescript
main().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
```
---

## 2. Config Read/Write Pattern

### Key Files
- `/Users/russe/documents/context_ledger/src/config.ts` — type definitions, `DEFAULT_CONFIG`, `loadConfig`
- `/Users/russe/documents/context_ledger/src/cli.ts` lines 359-398 — `handleInit()` creates `config.json`

### Config Creation (handleInit, lines 372-379):

```typescript
const cfgPath = configPath(projectRoot);
try {
  await access(cfgPath);
  console.log("config.json already exists, skipping.");
} catch {
  await writeFile(cfgPath, JSON.stringify(DEFAULT_CONFIG, null, 2) + "
", "utf8");
  console.log("Created .context-ledger/config.json");
}
```

Pattern: `access()` to test existence, skip if present, `writeFile` with trailing newline if absent. The `+ "
"` trailing newline is required everywhere `config.json` is written.

### Config Reading (loadConfig, src/config.ts lines 79-90):

```typescript
export async function loadConfig(projectRoot: string): Promise<LedgerConfig> {
  const filePath = join(projectRoot, ".context-ledger", "config.json");
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (err: any) {
    if (err.code === "ENOENT") return DEFAULT_CONFIG;
    throw err;
  }
  const fileConfig = JSON.parse(raw) as Partial<LedgerConfig>;
  return deepMerge(DEFAULT_CONFIG, fileConfig);
}
```

ENOENT is silently swallowed and `DEFAULT_CONFIG` returned. Any other error propagates. `deepMerge` ensures partial configs are valid.

### Config Updating (wizard must implement this):

No incremental patch API exists. Always read with `loadConfig`, mutate in memory, then `writeFile` the entire object back:

```typescript
const config = await loadConfig(projectRoot);
config.capture.scope_mappings["src/auth/"] = { type: "domain", id: "auth" };
await writeFile(configPath(projectRoot), JSON.stringify(config, null, 2) + "
", "utf8");
```

### Wizard-Relevant Config Fields:
- `capture.scope_mappings: {}` — wizard populates in Step 2
- `retrieval.feature_hint_mappings: {}` — wizard populates in Step 2

### Path Helpers (`src/ledger/storage.ts` lines 10-24):

```typescript
export function ledgerDir(projectRoot: string): string {
  return join(projectRoot, ".context-ledger");
}
export function configPath(projectRoot: string): string {
  return join(ledgerDir(projectRoot), "config.json");
}
```

Always use these helpers. Never construct `.context-ledger/` paths by hand.
---

## 3. Hook Installation Pattern

### Key File
`/Users/russe/documents/context_ledger/src/cli.ts` lines 400-475 — `installPostCommitHook()`

### Hook Script Template (lines 401-405):

The literal string written to the hook file:

```sh
#!/bin/sh
# context-ledger post-commit hook
# Instantaneous, deterministic — zero LLM calls, zero network calls.
node -e "import('@mossrussell/context-ledger/dist/capture/hook.js').then(m => m.postCommit()).catch(() => {})" 2>/dev/null || true
```

The package name in the dynamic import is `@mossrussell/context-ledger`, matching the `"name"` field in `package.json`. The marker string for detecting existing installations is `"context-ledger"`.

### Hook System Detection Order (lines 407-474):

1. **Husky** — check `await access(join(projectRoot, ".husky"))`. If `.husky/` exists, read or create `.husky/post-commit`. Append if marker absent.
2. **Lefthook** — check `await access(join(projectRoot, "lefthook.yml"))`. If present, print instructions only — no file write.
3. **simple-git-hooks** — check `pkg["simple-git-hooks"]` in package.json. If present, print instructions only.
4. **Bare git hooks** — check `await access(join(projectRoot, ".git", "hooks"))`. Write to `.git/hooks/post-commit` with append-or-create logic.

### ENOENT Pattern for Hook Detection:

```typescript
try {
  await access(huskyDir);
  // ... system detected
} catch { /* not husky */ }
```

Each detection step falls through the catch silently. No error code inspection.

### Append vs Create Logic (lines 413-430):

```typescript
try {
  await access(hookPath);
  const existing = await readFile(hookPath, "utf8");
  if (!existing.includes(marker)) {
    await writeFile(hookPath, existing.trimEnd() + "

" + hookScript, { mode: 0o755 });
  }
} catch {
  await writeFile(hookPath, hookScript, { mode: 0o755 });
}
```

File mode `{ mode: 0o755 }` is always set. Never use `appendFile` for hooks — must control the full content.
---

## 4. File Detection Pattern

### Imports Used

```typescript
import { readFile, mkdir, writeFile, access, unlink } from "node:fs/promises";
```

`access` is the universal existence check. `stat` is used in `src/capture/hook.ts` line 262 when file size matters.

### Existence Check Pattern:

```typescript
try {
  await access(path);
  // exists
} catch {
  // absent
}
```

The catch block never inspects the error code — treats any failure as absent. Exception: `loadConfig` explicitly checks `err.code === "ENOENT"` and rethrows other errors.

### Directory Creation:

```typescript
await mkdir(dir, { recursive: true });
```

Always use `{ recursive: true }` — silently succeeds if directory already exists.

### Directory Scanning (not yet in codebase — wizard must add):

```typescript
import { readdir } from "node:fs/promises";
const entries = await readdir(dir, { withFileTypes: true });
for (const entry of entries) {
  if (entry.isDirectory()) { ... }
}
```

### Canonical File Reading Pattern (`src/ledger/storage.ts` lines 46-52):

```typescript
try {
  content = await readFile(filePath, "utf8");
} catch (err: any) {
  if (err.code === "ENOENT") return [];
  throw err;
}
```

ENOENT returns empty/default. Other errors rethrow.
---

## 5. @clack/prompts Usage

### Installation
`package.json` line 47: `"@clack/prompts": "^1.2.0"`
Installed version in `node_modules/@clack/prompts/package.json`: `"version": "1.2.0"`

### @clack/prompts Is Not Yet Used in Any Source File

Confirmed via grep: `@clack/prompts` appears only in documentation, `package.json`, `package-lock.json`, and design docs. No `.ts` source file imports it yet. `src/setup.ts` is a 3-line stub.

### Import Pattern for src/setup.ts:

```typescript
import {
  intro, outro, cancel, note, log,
  text, confirm, select, multiselect,
  spinner, tasks, group,
  isCancel,
} from "@clack/prompts";
```

No `.js` extension for external packages. Only internal relative imports require `.js` extensions (Node16 resolution rule).

### Available APIs (from `/Users/russe/documents/context_ledger/node_modules/@clack/prompts/dist/index.d.mts`):

**Layout:**
- `intro(title?)` — start wizard header
- `outro(message?)` — end wizard footer
- `cancel(message?)` — cancel with message
- `note(message?, title?)` — informational note box
- `box(message?, title?, opts?)` — bordered box (1.2.0+)

**Prompts** — all return `Value | symbol`, must check `isCancel(result)` after every await:
- `text({ message, placeholder?, defaultValue?, validate? })` returns `Promise<string | symbol>`
- `confirm({ message, active?, inactive?, initialValue? })` returns `Promise<boolean | symbol>`
- `select({ message, options, initialValue? })` returns `Promise<Value | symbol>`; options are `{ value, label?, hint? }`
- `multiselect({ message, options, initialValues?, required? })` returns `Promise<Value[] | symbol>`
- `path({ message, directory?, initialValue?, validate? })` returns `Promise<string | symbol>` (1.2.0+)

**Flow control:**
- `group(prompts, opts?)` — run named prompt group with `onCancel` hook
- `tasks(tasks[])` — run async tasks with spinner per task; each task is `{ title, task(message), enabled? }`
- `spinner()` — manual spinner: `.start(msg)`, `.stop(msg)`, `.error(msg)`, `.message(msg)`, `.isCancelled`

**Logging:**
- `log.info(msg)`, `log.success(msg)`, `log.warn(msg)`, `log.error(msg)`, `log.step(msg)`

### Cancel Detection Pattern (mandatory after every prompt):

```typescript
import { isCancel } from "@clack/prompts";

const result = await text({ message: "..." });
if (isCancel(result)) {
  cancel("Setup cancelled.");
  process.exit(0);
}
```

### TypeScript Types Available:
- `Option<Value>` — `{ value, label?, hint?, disabled? }`
- `SpinnerResult` — `{ start(), stop(), cancel(), error(), message(), isCancelled }`
- `Task` — `{ title: string; task: (message) => string | void | Promise<...>; enabled?: boolean }`
---

## 6. Standing Instructions Injection Pattern

### Design Spec Context
`CLAUDE.md` Setup Wizard Step 4: "Standing Instructions Injection — Inject into CLAUDE.md/.cursorrules, respect agent-guard ordering"
Loading order rule: "agent-guard factual docs first, then context-ledger decision packs"

### Detection Pattern:

```typescript
const claudeMdPath = join(projectRoot, "CLAUDE.md");
try {
  const existing = await readFile(claudeMdPath, "utf8");
  if (existing.includes("context-ledger")) {
    // already injected — skip
  }
} catch {
  // file does not exist — try .cursorrules instead
}
```

Use `"context-ledger"` as the idempotency marker, matching the hook detection marker.

### Injection Requirement:
The injected block must tell the AI to call `query_decisions` at session start. Must be placed after any agent-guard block if one is present. Detect agent-guard presence by scanning for an agent-guard marker string before deciding insertion point.

---

## 7. Query/Retrieval Pattern

### Key Files
- `/Users/russe/documents/context_ledger/src/retrieval/query.ts` — `queryDecisions()`, `searchDecisions()`
- `/Users/russe/documents/context_ledger/src/retrieval/packs.ts` — `DecisionPack`, `buildDecisionPack()`
- `/Users/russe/documents/context_ledger/src/retrieval/scope.ts` — `deriveScope()`

### queryDecisions() Signature (`src/retrieval/query.ts` lines 36-154):

```typescript
export async function queryDecisions(
  params: QueryDecisionsParams,
  projectRoot: string,
): Promise<DecisionPack>
```

### DecisionPack Return Type (`src/retrieval/packs.ts` lines 31-40):

```typescript
export interface DecisionPack {
  derived_scope: DerivedScope | null;
  active_precedents: PackEntry[];       // sorted by retrieval_weight desc
  abandoned_approaches: AbandonedEntry[];
  recently_superseded: SupersededEntry[];
  pending_inbox_items: InboxItem[];
  no_precedent_scopes: string[];
  token_estimate: number;
  truncated: boolean;
}
```

### First-Run Demo Usage (Step 5):

When the ledger is empty, `active_precedents` is `[]` and `derived_scope` is `null`. The wizard must handle this gracefully.

```typescript
import { queryDecisions } from "./retrieval/index.js";
const pack = await queryDecisions({ query: "architecture patterns" }, projectRoot);
```

### searchDecisions() (`src/retrieval/query.ts` lines 158-194):

```typescript
export async function searchDecisions(
  query: string,
  projectRoot: string,
  limit?: number,
): Promise<SearchResult[]>
```

Returns simpler `SearchResult[]` — good for demo display. Each result is `{ record: DecisionRecord; state: LifecycleState; effective_rank_score: number }`.
---

## 8. Error Handling Pattern

### MCP Tools — Return structured errors, never throw (`src/mcp/write-tools.ts` lines 57-64):

```typescript
function makeToolError(message: string) {
  console.error(`[context-ledger] Tool error: ${message}`);
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ status: "error", message }, null, 2) }],
    isError: true as const
  };
}
```

### CLI Commands — Throw, top-level catch handles (`src/cli.ts` lines 838-840):

```typescript
main().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
```

### Hook — Swallow all errors silently (`src/capture/hook.ts` lines 307-309):

```typescript
} catch (err: unknown) {
  debug(`Hook error (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
}
```

### Setup Wizard Error Pattern:
Wrap wizard body in try/catch. On `isCancel`, call `cancel()` and `process.exit(0)`. On unexpected errors, call `cancel()` with the error message and `process.exit(1)`. Top-level `.catch` handles unhandled rejections.

### ENOENT-safe reads:
Always check `err.code === "ENOENT"` when reading optional files. See `loadConfig` in `src/config.ts` and `readLedger` in `src/ledger/storage.ts` for the canonical form.

---

## 9. Module Entry Point Pattern

### package.json bin entries (lines 7-11):

```json
"bin": {
  "context-ledger": "dist/cli.js",
  "context-ledger-mcp": "dist/mcp-server-bin.js",
  "context-ledger-setup": "dist/setup.js"
}
```

`context-ledger-setup` maps directly to `dist/setup.js` — the compiled output of `src/setup.ts`. Standalone binary, not delegated through `src/cli.ts`.

### Shebang and Entry Point Pattern (`src/mcp-server-bin.ts` lines 1-9):

```typescript
#!/usr/bin/env node
// context-ledger-mcp — standalone MCP server bin entry
import { startMcpServer } from "./mcp-server.js";

const projectRoot = process.env.CONTEXT_LEDGER_PROJECT_ROOT ?? process.cwd();
startMcpServer(projectRoot).catch((error) => {
  console.error("[context-ledger] Fatal error:", error);
  process.exit(1);
});
```

Every standalone binary entry point must:
1. Have `#!/usr/bin/env node` as first line
2. Resolve `projectRoot` from `process.env.CONTEXT_LEDGER_PROJECT_ROOT ?? process.cwd()`
3. Call the exported main function
4. Chain `.catch((error) => { console.error(...); process.exit(1); })`

### Required Structure for src/setup.ts:

```typescript
#!/usr/bin/env node
// context-ledger — interactive setup wizard

import { intro, outro, cancel, ... } from "@clack/prompts";
import { loadConfig, DEFAULT_CONFIG } from "./config.js";
import { ledgerDir, configPath } from "./ledger/storage.js";
// ... other internal imports with .js extensions

const projectRoot = process.env.CONTEXT_LEDGER_PROJECT_ROOT ?? process.cwd();

async function main(): Promise<void> {
  // wizard body
}

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
```

### tsconfig.json Settings:
- `target: ES2022`, `module: Node16`, `moduleResolution: Node16`
- `strict: true`, `types: ["node"]`
- Node16 module resolution requires `.js` extensions on all relative imports; external packages do not need `.js`.
---

## Key Files Summary

| File | Role |
|------|------|
| `/Users/russe/documents/context_ledger/src/cli.ts` | CLI dispatch, `handleInit`, `installPostCommitHook` |
| `/Users/russe/documents/context_ledger/src/config.ts` | `DEFAULT_CONFIG`, `loadConfig`, `LedgerConfig` type |
| `/Users/russe/documents/context_ledger/src/setup.ts` | Stub — target for implementation |
| `/Users/russe/documents/context_ledger/src/ledger/storage.ts` | `appendToLedger`, `readLedger`, path helpers |
| `/Users/russe/documents/context_ledger/src/ledger/events.ts` | All event types, ID generators, type guards |
| `/Users/russe/documents/context_ledger/src/ledger/fold.ts` | `foldLedger`, `foldEvents`, `FoldedDecision` |
| `/Users/russe/documents/context_ledger/src/retrieval/query.ts` | `queryDecisions`, `searchDecisions` |
| `/Users/russe/documents/context_ledger/src/retrieval/packs.ts` | `DecisionPack`, `buildDecisionPack` |
| `/Users/russe/documents/context_ledger/src/retrieval/scope.ts` | `deriveScope`, `DerivedScope` |
| `/Users/russe/documents/context_ledger/src/mcp-server-bin.ts` | Binary entry point pattern reference |
| `/Users/russe/documents/context_ledger/src/mcp/read-tools.ts` | MCP tool registration pattern |
| `/Users/russe/documents/context_ledger/src/mcp/write-tools.ts` | `makeToolResult`, `makeToolError` pattern |
| `/Users/russe/documents/context_ledger/src/capture/hook.ts` | Hook error swallowing pattern |
| `/Users/russe/documents/context_ledger/node_modules/@clack/prompts/dist/index.d.mts` | Full @clack/prompts type definitions |
| `/Users/russe/documents/context_ledger/package.json` | bin entries, @clack/prompts version |
| `/Users/russe/documents/context_ledger/tsconfig.json` | Node16 module resolution, strict mode |

---

## Inconsistencies and Flags

### Flag 1: handleSetup() in cli.ts Does Not Delegate to src/setup.ts
`src/cli.ts` line 830: `handleSetup()` prints an error and exits. `package.json` also declares `context-ledger-setup` as a separate binary pointing to `dist/setup.js`. Once `src/setup.ts` is implemented, `handleSetup()` in `src/cli.ts` should import and call the wizard from `src/setup.ts` rather than being a dead-end stub.

### Flag 2: @clack/prompts Runtime Transitive Dependencies
`package.json` lists `@clack/prompts` as a runtime dependency. Installed 1.2.0 depends on `@clack/core`, `fast-string-width`, `fast-wrap-ansi`, and `sisteransi`. `CLAUDE.md` states "Zero other runtime dependencies" but qualifies this with `@clack/prompts` as the single allowed exception per the design spec. Intentional.

### Flag 3: Version Skew in Design Doc vs. package.json
`context-ledger-design-v2.md` line 780 references `"@clack/prompts": "^1.1.0"` but `package.json` has `"^1.2.0"`. Installed version is `1.2.0`. Use the 1.2.0 API — it includes components not in 1.1.0: `box`, `path`, `autocomplete`, `autocompleteMultiselect`, `progress`, `taskLog`, `stream`, `selectKey`.

### Flag 4: mcp-server.ts Hardcodes version: "0.1.0"
`src/mcp-server.ts` line 9: `version: "0.1.0"` while `package.json` is at `0.5.4`. Not relevant to the wizard but a staleness indicator.
