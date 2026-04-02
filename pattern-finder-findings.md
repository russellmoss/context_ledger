# Pattern Finder Findings — capture/ Implementation

## 1. JSONL Append Pattern (`src/ledger/storage.ts:39-42`)
```typescript
export async function appendToInbox(item: InboxItem, projectRoot: string): Promise<void> {
  await ensureLedgerDir(projectRoot);
  await appendFile(inboxPath(projectRoot), JSON.stringify(item) + "\n", "utf8");
}
```
- Always `JSON.stringify(item) + "\n"` — trailing newline, never inside JSON
- `ensureLedgerDir` called before every write (mkdir recursive)
- Hook MUST use `appendToInbox`, NEVER `rewriteInbox`

## 2. Config Loading (`src/config.ts:79-90`)
```typescript
export async function loadConfig(projectRoot: string): Promise<LedgerConfig>
```
- Returns `DEFAULT_CONFIG` on `ENOENT`
- Deep merge: arrays replace entirely, objects merge recursively

Usage pattern (from `src/retrieval/query.ts`):
```typescript
const [config, state] = await Promise.all([loadConfig(projectRoot), foldLedger(projectRoot)]);
```

## 3. ID Generation (`src/ledger/events.ts:124-128`)
```typescript
export function generateInboxId(): string {
  const unix = Math.floor(Date.now() / 1000);
  const hex = Math.floor(Math.random() * 0xff).toString(16).padStart(2, "0");
  return `q_${unix}_${hex}`;
}
```

## 4. Error Handling
- **MCP tools**: try/catch → `makeToolError(err.message)` with `isError: true`
- **CLI**: `console.error("message"); process.exit(1)`
- **Post-commit hook**: MUST exit 0 on any error — never block a commit
  ```typescript
  postCommit().catch((err) => { console.error("[context-ledger]", err.message); });
  ```
- All diagnostics to `console.error` (stdout reserved for MCP JSON-RPC)

## 5. Reference classifyCommit in cli.ts (lines 633-653)
```typescript
function classifyCommit(commit: BackfillCommit): string {
  const { message, files } = commit;
  if (files.some(f => f === "package.json" || f === "package-lock.json")) return "dependency-change";
  if (files.some(f => f.includes(".env"))) return "env-var-change";
  if (files.some(f => /tsconfig|eslint|\.prettierrc|jest\.config|vitest|\.github/.test(f))) return "config-change";
  if (files.some(f => /schema|migration|\.prisma|\.sql/.test(f))) return "schema-change";
  if (files.some(f => /\/api\/|\/routes?\//.test(f))) return "api-route-change";
  if (msg.includes("delete") || msg.includes("remove") || msg.includes("drop")) return "removal";
  if (files.length >= 5) return "multi-file-change";
  return "other";
}
```
Missing vs design spec: new-directory detection, diff-filter deletion, Tier 2 rules, config awareness.

## 6. foldLedger Usage
```typescript
const state = await foldLedger(projectRoot);
for (const [, folded] of state.decisions) {
  if (folded.state === "active" && folded.record.scope.type === scope.type && folded.record.scope.id === scope.id) {
    // Active decision in same scope — Tier 2 signal
  }
}
```

## 7. deriveScope Usage
```typescript
const derived = deriveScope({ file_path: changedFile }, config, state.decisions);
// Returns null when no scope can be derived
```

## 8. child_process / execSync Pattern (from cli.ts backfill)
```typescript
import { execSync } from "node:child_process";
execSync(`git ...`, { cwd: projectRoot, encoding: "utf8" });
```
Git commands for hook:
- `git rev-parse HEAD` — commit SHA
- `git log -1 --format=%s HEAD` — subject line
- `git diff-tree --no-commit-id -r --name-only HEAD` — all changed files
- `git diff-tree --no-commit-id -r --diff-filter=D --name-only HEAD` — deleted files
- `git diff-tree --no-commit-id -r --diff-filter=A --name-only HEAD` — added files

## 9. Barrel Export Pattern
```typescript
// src/mcp/index.ts pattern:
export { registerReadTools } from "./read-tools.js";
export { registerWriteTools } from "./write-tools.js";
```
`src/capture/index.ts` should follow:
```typescript
export { classifyCommit } from "./classify.js";
export type { ClassifyResult } from "./classify.js";
export { postCommit } from "./hook.js";
```

## 10. projectRoot Resolution
```typescript
const projectRoot = process.env.CONTEXT_LEDGER_PROJECT_ROOT ?? process.cwd();
```

## 11. Import Map for src/capture/
```typescript
// classify.ts
import type { LedgerConfig } from "../config.js";

// hook.ts
import { execSync } from "node:child_process";
import type { InboxItem } from "../ledger/index.js";
import { generateInboxId, appendToInbox, foldLedger } from "../ledger/index.js";
import { loadConfig } from "../config.js";
import { deriveScope, normalizePath } from "../retrieval/index.js";
import { classifyCommit } from "./classify.js";
```

## 12. Inconsistencies / Flags
1. cli.ts classifyCommit ignores config — capture/classify.ts must accept and respect config
2. cli.ts backfill TTL hardcoded (14 days literal) — hook must use `config.capture.inbox_ttl_days`
3. All three src/capture/ files are stubs — full replacement needed
4. readInbox returns [] on ENOENT — safe to call for dedup check on first commit
