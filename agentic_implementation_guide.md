# Agentic Implementation Guide — CLI (src/cli.ts)

**Feature:** Full CLI implementation — 10 commands, --help, --version, Node built-ins only
**Spec:** context-ledger-design-v2.md
**Exploration:** exploration-results.md, code-inspector-findings.md, pattern-finder-findings.md

---

## Pre-Implementation Checklist

Before starting, verify:
```bash
# Build succeeds with current code
npx tsc --noEmit

# Core modules are functional
node -e "import('./dist/ledger/index.js').then(m => console.log('ledger OK'))"
node -e "import('./dist/retrieval/index.js').then(m => console.log('retrieval OK'))"
node -e "import('./dist/config.js').then(m => console.log('config OK'))"
```

---

## Phase 1: Core CLI Framework + Serve Command

**Files:** `src/cli.ts`, `src/mcp-server.ts`

### Step 1.1: Extract startMcpServer from mcp-server.ts

In `src/mcp-server.ts`, refactor the top-level code into an exported `startMcpServer(projectRoot: string)` function so the CLI can call it. Keep the existing self-running behavior for the `context-ledger-mcp` bin entry.

The file currently has top-level `const server = new McpServer(...)` at line 11. Wrap lines 11-23 into:

```typescript
export async function startMcpServer(projectRoot: string): Promise<void> {
  const server = new McpServer({ name: "context-ledger", version: "0.1.0" });
  registerReadTools(server, projectRoot);
  registerWriteTools(server, projectRoot);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[context-ledger] MCP server running on stdio");
}
```

Remove all self-execution code from `mcp-server.ts`. It should only export `startMcpServer`.

Then create a new file `src/mcp-server-bin.ts` — the thin bin entry for `context-ledger-mcp`:

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

Update `package.json` bin entry to point `context-ledger-mcp` at `dist/mcp-server-bin.js` instead of `dist/mcp-server.js`.

**Council fix C4:** This eliminates the brittle `argv[1]` guard entirely. No symlink/npx/runtime issues.

### Step 1.2: Implement CLI framework in src/cli.ts

Replace the 3-line stub with the full CLI. Structure:

```typescript
#!/usr/bin/env node
// context-ledger — CLI entry point
// All command output goes to stdout. Diagnostics and errors to stderr.

import { readFile, mkdir, writeFile, access, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Internal imports — all .js extensions
import { DEFAULT_CONFIG, loadConfig } from "./config.js";
import {
  readLedger, readInbox, rewriteInbox, foldLedger,
  LedgerIntegrityError, ledgerDir, configPath,
  isDecisionRecord, isTransitionEvent,
  generateDecisionId, appendToLedger,
} from "./ledger/index.js";
import type {
  FoldedDecision, MaterializedState, LifecycleState,
  DecisionRecord, InboxItem, EvidenceType, Durability,
} from "./ledger/index.js";
import { searchDecisions } from "./retrieval/index.js";
import type { SearchResult } from "./retrieval/index.js";
import { startMcpServer } from "./mcp-server.js";
```

**projectRoot resolution** (must match mcp-server.ts pattern):
```typescript
const projectRoot = process.env.CONTEXT_LEDGER_PROJECT_ROOT ?? process.cwd();
```

**Argv parsing** — manual, no dependencies:
```typescript
const args = process.argv.slice(2);
const command = args[0];

// Council fix S3: Helper to parse --flag value AND --flag=value
function getFlag(flag: string): string | undefined {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag && i + 1 < args.length) return args[i + 1];
    if (args[i].startsWith(flag + "=")) return args[i].slice(flag.length + 1);
  }
  return undefined;
}

function hasFlag(flag: string): boolean {
  return args.includes(flag);
}
```

**Command dispatch:**
```typescript
async function main(): Promise<void> {
  switch (command) {
    case "init": return handleInit();
    case "serve": return handleServe();
    case "query": return handleQuery();
    case "stats": return handleStats();
    case "export": return handleExport();
    case "validate": return handleValidate();
    case "tidy": return handleTidy();
    case "backfill": return handleBackfill();
    case "setup": return handleSetup();
    case "--help": case "-h": return printHelp();
    case "--version": case "-v": return printVersion();
    default:
      if (!command) { printHelp(); return; }
      console.error(`Unknown command: ${command}`);
      printHelp();
      process.exit(1);
  }
}
```

**Pre-flight check for commands that need the ledger directory (Council fix S4):**
```typescript
const NEEDS_LEDGER = new Set(["query", "stats", "export", "validate", "tidy", "backfill"]);

async function ensureLedgerExists(): Promise<void> {
  if (!NEEDS_LEDGER.has(command)) return;
  try {
    await access(ledgerDir(projectRoot));
  } catch {
    console.error("Error: .context-ledger/ directory not found.");
    console.error("Run 'context-ledger init' to initialize.");
    process.exit(1);
  }
}
```

Call `await ensureLedgerExists()` at the top of `main()` before the switch statement.

**Error wrapper:**
```typescript
main().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
```

### Step 1.3: Implement --help and --version

**--version:** Read from package.json using `fileURLToPath` + `import.meta.url`:
```typescript
async function printVersion(): Promise<void> {
  const __dirname = fileURLToPath(new URL(".", import.meta.url));
  const pkgPath = join(__dirname, "..", "package.json");
  const pkg = JSON.parse(await readFile(pkgPath, "utf8"));
  console.log(`context-ledger v${pkg.version}`);
}
```

**--help:** Static text listing all commands (Council fix S1: --apply-repair marked):
```
Usage: context-ledger <command> [options]

Commands:
  init                          Create .context-ledger/ and install hook
  serve                         Start MCP server over stdio
  query <text>                  Search decisions (lexical, active only)
  stats                         Show decision and inbox statistics
  export --format json|csv|jsonl Export decisions to stdout
  validate                      Check ledger integrity
  validate --propose-repair     Suggest repairs without modifying files
  validate --apply-repair       Apply repair plan (not yet implemented)
  tidy                          Remove stale inbox entries (>30 days)
  backfill --max <N>            Backfill from git history (default 5)
  backfill --resume             Resume interrupted backfill
  setup                         Run interactive setup wizard

Options:
  --help, -h                    Show this help
  --version, -v                 Show version

Use 'context-ledger <command> --help' for command-specific help.
```

**Sub-command help (Council fix S7):** In the main switch, before dispatching each command, check if `args.includes("--help")`. If so, print command-specific usage and return. Example for export:
```
Usage: context-ledger export --format <json|csv>
  --format json    Output materialized decisions as JSON array
  --format csv     Output decisions as CSV with header row
```

### Step 1.4: Implement serve command

```typescript
async function handleServe(): Promise<void> {
  await startMcpServer(projectRoot);
}
```

### Validation Gate — Phase 1

```bash
# Build
npx tsc --noEmit

# --help works
node dist/cli.js --help

# --version works
node dist/cli.js --version

# serve starts (test by running and pressing Ctrl+C)
# Note: serve locks stdout for JSON-RPC, just verify it starts without error
```

**STOP AND REPORT:** Phase 1 complete. Verify --help, --version, serve work. Then proceed.

---

## Phase 2: Read Commands (query, stats, export)

**Files:** `src/cli.ts` (append handlers)

### Step 2.1: query command

```typescript
async function handleQuery(): Promise<void> {
  const queryText = args.slice(1).join(" ");
  if (!queryText) {
    console.error("Usage: context-ledger query <text>");
    process.exit(1);
  }

  const results = await searchDecisions(queryText, projectRoot);

  if (results.length === 0) {
    console.log("No matching decisions found.");
    return;
  }

  console.log(`Found ${results.length} decision(s):\n`);
  for (const r of results) {
    console.log(`  ${r.record.id}  [${r.state}]  score=${r.effective_rank_score.toFixed(2)}`);
    console.log(`    ${r.record.summary}`);
    console.log(`    scope: ${r.record.scope.type}/${r.record.scope.id}`);
    console.log(`    kind: ${r.record.decision_kind}  durability: ${r.record.durability}`);
    console.log("");
  }
}
```

### Step 2.2: stats command

```typescript
async function handleStats(): Promise<void> {
  const state = await foldLedger(projectRoot);
  const inbox = await readInbox(projectRoot);

  const decisions = Array.from(state.decisions.values());
  const total = decisions.length;

  if (total === 0 && inbox.length === 0) {
    console.log("No decisions or inbox items found.");
    return;
  }

  // Spec-mandated groupings: source, kind, scope, evidence type, verification status
  const bySource = countBy(decisions, (d) => d.record.source);
  const byKind = countBy(decisions, (d) => d.record.decision_kind);
  const byScope = countBy(decisions, (d) => `${d.record.scope.type}/${d.record.scope.id}`);
  const byEvidence = countBy(decisions, (d) => d.record.evidence_type);
  const byVerification = countBy(decisions, (d) => d.record.verification_status);
  // Bonus groupings (useful but not spec-required)
  const byState = countBy(decisions, (d) => d.state);
  const byDurability = countBy(decisions, (d) => d.record.durability);

  console.log(`Decisions: ${total} total\n`);
  printSection("By Source", bySource);
  printSection("By Decision Kind", byKind);
  printSection("By Scope", byScope);
  printSection("By Evidence Type", byEvidence);
  printSection("By Verification Status", byVerification);
  printSection("By State", byState);
  printSection("By Durability", byDurability);

  // Inbox summary
  const byInboxStatus = countBy(inbox, (i) => i.status);
  console.log(`\nInbox: ${inbox.length} total`);
  printSection("By Status", byInboxStatus);
}

// Utility: count occurrences by key extractor
function countBy<T>(items: T[], keyFn: (item: T) => string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) {
    const key = keyFn(item);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function printSection(title: string, counts: Map<string, number>): void {
  console.log(`  ${title}:`);
  for (const [key, count] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${key}: ${count}`);
  }
}
```

### Step 2.3: export command

```typescript
async function handleExport(): Promise<void> {
  const format = getFlag("--format");

  if (!format || !["json", "csv", "jsonl"].includes(format)) {
    console.error("Usage: context-ledger export --format json|csv|jsonl");
    process.exit(1);
  }

  const state = await foldLedger(projectRoot);
  const decisions = Array.from(state.decisions.values());

  if (format === "jsonl") {
    // Raw ledger events as JSON array (D1: Option C — raw dump)
    const events = await readLedger(projectRoot);
    console.log(JSON.stringify(events, null, 2));
    return;
  }

  if (format === "json") {
    // Materialized decisions with current state and scores (D1: Option C — materialized)
    const output = decisions.map((d) => ({
      ...d.record,
      current_state: d.state,
      effective_rank_score: d.effective_rank_score,
      reinforcement_count: d.reinforcement_count,
    }));
    console.log(JSON.stringify(output, null, 2));
  } else {
    // CSV
    const header = "decision_id,summary,state,scope_type,scope_id,decision_kind,durability,evidence_type,created";
    console.log(header);
    for (const d of decisions) {
      const row = [
        d.record.id,
        csvEscape(d.record.summary),
        d.state,
        d.record.scope.type,
        d.record.scope.id,
        csvEscape(d.record.decision_kind),
        d.record.durability,
        d.record.evidence_type,
        d.record.created,
      ].join(",");
      console.log(row);
    }
  }
}

function csvEscape(value: string): string {
  if (value.includes(",") || value.includes('"') || value.includes("\n")) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}
```

### Validation Gate — Phase 2

```bash
npx tsc --noEmit

# query (requires existing ledger data)
node dist/cli.js query "event sourcing"

# stats
node dist/cli.js stats

# export json
node dist/cli.js export --format json | head -20

# export csv
node dist/cli.js export --format csv | head -5
```

**STOP AND REPORT:** Phase 2 complete. All read commands working. Proceed to Phase 3.

---

## Phase 3: Validation Commands

**Files:** `src/cli.ts` (append handlers)

### Step 3.1: validate command

```typescript
async function handleValidate(): Promise<void> {
  const subcommand = args[1]; // --propose-repair or --apply-repair or undefined
  const issues: string[] = [];

  // Council fix C6: Raw JSONL line-by-line check BEFORE folding
  for (const [label, filePath] of [["ledger", ledgerPath(projectRoot)], ["inbox", inboxPath(projectRoot)]] as const) {
    try {
      const raw = await readFile(resolve(projectRoot, filePath), "utf8");
      const lines = raw.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (line === "") continue;
        try { JSON.parse(line); } catch {
          issues.push(`Malformed JSON on line ${i + 1} of ${label}.jsonl`);
        }
      }
    } catch (err: any) {
      if (err.code !== "ENOENT") issues.push(`Cannot read ${label}: ${err.message}`);
    }
  }

  // Run fold with strict: false to collect lifecycle warnings
  const state = await foldLedger(projectRoot, { strict: false });
  const inbox = await readInbox(projectRoot);
  const decisions = Array.from(state.decisions.values());
  issues.push(...state.warnings);

  // Check for stale file references (D3: warnings only, not errors)
  const warnings: string[] = [];
  for (const d of decisions) {
    if (d.state !== "active") continue;
    for (const filePath of d.record.affected_files) {
      try {
        await access(resolve(projectRoot, filePath));
      } catch {
        warnings.push(`Stale file reference in ${d.record.id}: ${filePath} does not exist`);
      }
    }
  }

  // Check inbox structural integrity
  for (const item of inbox) {
    if (!item.inbox_id || !item.status || !item.created) {
      issues.push(`Malformed inbox item: missing required fields (id=${item.inbox_id})`);
    }
  }

  if (subcommand === "--propose-repair") {
    return proposeRepair(state, issues);
  }

  if (subcommand === "--apply-repair") {
    console.error("validate --apply-repair is not yet implemented.");
    console.error("Use --propose-repair to generate a repair plan first.");
    process.exit(1);
  }

  // Default: report issues and warnings separately
  if (warnings.length > 0) {
    console.log(`Warnings (${warnings.length}):`);
    for (const w of warnings) console.log(`  - ${w}`);
    console.log("");
  }

  if (issues.length === 0) {
    console.log(`Ledger integrity check passed.${warnings.length > 0 ? ` ${warnings.length} warning(s).` : " No issues found."}`);
    return;
  }

  console.log(`Errors (${issues.length}):`);
  for (const issue of issues) {
    console.log(`  - ${issue}`);
  }
  process.exit(1); // D3: Only errors cause exit 1, not stale file warnings
}
```

### Step 3.2: validate --propose-repair

```typescript
async function proposeRepair(state: MaterializedState, issues: string[]): Promise<void> {
  const decisions = Array.from(state.decisions.values());
  const repairs: string[] = [];

  // Near-duplicate detection: same scope + similar summary
  const activeByScope = new Map<string, FoldedDecision[]>();
  for (const d of decisions) {
    if (d.state !== "active") continue;
    const scopeKey = `${d.record.scope.type}/${d.record.scope.id}`;
    if (!activeByScope.has(scopeKey)) activeByScope.set(scopeKey, []);
    activeByScope.get(scopeKey)!.push(d);
  }

  for (const [scopeKey, scopeDecisions] of activeByScope) {
    if (scopeDecisions.length < 2) continue;
    // Flag scopes with multiple active decisions for review
    repairs.push(
      `REVIEW: Scope "${scopeKey}" has ${scopeDecisions.length} active decisions: ${scopeDecisions.map(d => d.record.id).join(", ")}. Consider superseding duplicates.`
    );
  }

  // Stale scope aliases
  for (const d of decisions) {
    if (d.state !== "active") continue;
    for (const alias of d.record.scope_aliases) {
      try {
        await access(resolve(projectRoot, alias));
      } catch {
        repairs.push(
          `UPDATE: Scope alias "${alias}" in ${d.record.id} no longer exists. Consider removing or updating.`
        );
      }
    }
  }

  if (issues.length === 0 && repairs.length === 0) {
    console.log("No issues or repair suggestions found.");
    return;
  }

  if (issues.length > 0) {
    console.log(`Issues (${issues.length}):`);
    for (const issue of issues) console.log(`  - ${issue}`);
    console.log("");
  }

  if (repairs.length > 0) {
    console.log(`Repair Suggestions (${repairs.length}):`);
    for (const repair of repairs) console.log(`  - ${repair}`);
  }
}
```

### Validation Gate — Phase 3

```bash
npx tsc --noEmit

# validate
node dist/cli.js validate

# validate --propose-repair
node dist/cli.js validate --propose-repair
```

**STOP AND REPORT:** Phase 3 complete. Validation commands working. Proceed to Phase 4.

---

## Phase 4: Write Commands (init, tidy)

**Files:** `src/cli.ts` (append handlers)

### Step 4.1: init command

```typescript
async function handleInit(): Promise<void> {
  const dir = ledgerDir(projectRoot);

  // Create directory
  await mkdir(dir, { recursive: true });

  // Write default config
  const cfgPath = configPath(projectRoot);
  try {
    await access(cfgPath);
    console.log("config.json already exists, skipping.");
  } catch {
    await writeFile(cfgPath, JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n", "utf8");
    console.log("Created .context-ledger/config.json");
  }

  // Create .gitkeep
  const gitkeepPath = join(dir, ".gitkeep");
  try {
    await access(gitkeepPath);
  } catch {
    await writeFile(gitkeepPath, "", "utf8");
  }

  // Detect and install post-commit hook
  await installPostCommitHook();

  console.log("\ncontext-ledger initialized successfully!");
  console.log("\nNext steps:");
  console.log("  1. Run 'context-ledger setup' for guided configuration");
  console.log("  2. Add .context-ledger/ to your .gitignore (except config.json)");
  console.log("  3. Start capturing decisions with your MCP client");
}
```

**Hook installation logic:**

```typescript
async function installPostCommitHook(): Promise<void> {
  const hookScript = `#!/bin/sh
# context-ledger post-commit hook
# Instantaneous, deterministic — zero LLM calls, zero network calls.
node -e "import('context-ledger/dist/capture/hook.js').then(m => m.postCommit()).catch(() => {})" 2>/dev/null || true
`;

  // Check for Husky (.husky/)
  const huskyDir = join(projectRoot, ".husky");
  try {
    await access(huskyDir);
    const hookPath = join(huskyDir, "post-commit");
    await writeFile(hookPath, hookScript, { mode: 0o755 });
    console.log("Installed post-commit hook via Husky (.husky/post-commit)");
    return;
  } catch { /* not husky */ }

  // Check for Lefthook (lefthook.yml)
  try {
    await access(join(projectRoot, "lefthook.yml"));
    console.log("Lefthook detected. Add the following to your lefthook.yml:");
    console.log('  post-commit:\n    commands:\n      context-ledger:\n        run: node -e "import(\'context-ledger/dist/capture/hook.js\').then(m => m.postCommit()).catch(() => {})"');
    return;
  } catch { /* not lefthook */ }

  // Check for simple-git-hooks
  try {
    const pkg = JSON.parse(await readFile(join(projectRoot, "package.json"), "utf8"));
    if (pkg["simple-git-hooks"]) {
      console.log("simple-git-hooks detected. Add to package.json:");
      console.log('  "simple-git-hooks": { "post-commit": "node -e \\"import(\'context-ledger/dist/capture/hook.js\').then(m => m.postCommit()).catch(() => {})\\"" }');
      return;
    }
  } catch { /* ignore */ }

  // Bare .git/hooks/
  const bareHookDir = join(projectRoot, ".git", "hooks");
  try {
    await access(bareHookDir);
    const hookPath = join(bareHookDir, "post-commit");
    try {
      await access(hookPath);
      // Hook already exists — append
      const existing = await readFile(hookPath, "utf8");
      if (!existing.includes("context-ledger")) {
        await writeFile(hookPath, existing.trimEnd() + "\n\n" + hookScript, { mode: 0o755 });
        console.log("Appended context-ledger to existing .git/hooks/post-commit");
      } else {
        console.log("post-commit hook already contains context-ledger, skipping.");
      }
    } catch {
      // No existing hook — create
      await writeFile(hookPath, hookScript, { mode: 0o755 });
      console.log("Installed post-commit hook to .git/hooks/post-commit");
    }
  } catch {
    console.error("Warning: Could not find .git/hooks/ directory. Hook not installed.");
    console.error("Run 'context-ledger init' from your git repository root.");
  }
}
```

### Step 4.2: tidy command

```typescript
async function handleTidy(): Promise<void> {
  const inbox = await readInbox(projectRoot);
  const now = Date.now();
  const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
  const terminalStatuses = new Set(["dismissed", "expired", "ignored"]);

  // First: mark pending items that should transition
  const config = await loadConfig(projectRoot);
  const processed = inbox.map((item) => {
    if (item.status !== "pending") return item;
    // Expire if past TTL
    if (new Date(item.expires_after).getTime() < now) {
      return { ...item, status: "expired" as const };
    }
    // Ignore if shown too many times
    if (item.times_shown >= config.capture.inbox_max_prompts_per_item) {
      return { ...item, status: "ignored" as const };
    }
    return item;
  });

  // Filter out terminal entries older than 30 days
  const kept = processed.filter((item) => {
    if (!terminalStatuses.has(item.status)) return true;
    const age = now - new Date(item.created).getTime();
    return age < thirtyDaysMs;
  });

  const removed = inbox.length - kept.length;

  if (removed === 0) {
    console.log("No stale inbox entries to remove.");
    return;
  }

  await rewriteInbox(kept, projectRoot);
  console.log(`Removed ${removed} stale inbox entries. ${kept.length} entries remaining.`);
}
```

### Validation Gate — Phase 4

```bash
npx tsc --noEmit

# init (run in a temp dir to avoid clobbering)
# Or test in current project — config.json already exists so it skips
node dist/cli.js init

# tidy
node dist/cli.js tidy
```

**STOP AND REPORT:** Phase 4 complete. init and tidy working. Proceed to Phase 5.

---

## Phase 5: Backfill Commands

**Files:** `src/cli.ts` (append handlers)

### Step 5.1: backfill --max N

The backfill command reads git log, classifies structural commits, and presents them for the user to review. Since `src/capture/classify.ts` is a stub, implement lightweight classification inline.

```typescript
async function handleBackfill(): Promise<void> {
  const isResume = args.includes("--resume");
  const maxIdx = args.indexOf("--max");
  const maxCommits = maxIdx >= 0 ? parseInt(args[maxIdx + 1], 10) : 5;

  if (isNaN(maxCommits) || maxCommits < 1) {
    console.error("Usage: context-ledger backfill --max <N> (N must be a positive integer)");
    process.exit(1);
  }

  if (isResume) {
    return resumeBackfill();
  }

  // Get structural commits from last 90 days
  // Council fix C3: Use NUL byte delimiter to avoid commit messages with "|"
  const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
  let gitLog: string;
  try {
    gitLog = execSync(
      `git log --since="${ninetyDaysAgo}" --format="%H%x00%s%x00%ai" --diff-filter=ADRC --name-only`,
      { cwd: projectRoot, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 }
    );
  } catch (err: any) {
    console.error("Failed to read git log. Are you in a git repository?");
    process.exit(1);
  }

  // Parse git log into commit records
  const commits = parseGitLog(gitLog);

  // Filter to structural commits only
  const structural = commits.filter((c) => isStructuralCommit(c));

  if (structural.length === 0) {
    console.log("No structural commits found in the last 90 days.");
    return;
  }

  // Council fix C2 (partial): Group by top-level directory for scope-area UX
  const byDirectory = new Map<string, BackfillCommit[]>();
  for (const c of structural) {
    const dir = c.files.length > 0 ? c.files[0].split("/")[0] : "root";
    if (!byDirectory.has(dir)) byDirectory.set(dir, []);
    byDirectory.get(dir)!.push(c);
  }

  console.log(`Found ${structural.length} structural commit(s) in ${byDirectory.size} area(s). Processing up to ${maxCommits}.\n`);

  let captured = 0;
  let remaining: string[] = [];

  for (const [dir, dirCommits] of byDirectory) {
    if (captured >= maxCommits) {
      remaining.push(...dirCommits.map((c) => c.sha));
      continue;
    }
    console.log(`--- Area: ${dir}/ (${dirCommits.length} commits) ---\n`);
    for (const commit of dirCommits) {
      if (captured >= maxCommits) {
        remaining.push(commit.sha);
        continue;
      }

    console.log(`Commit: ${commit.sha.slice(0, 8)} — ${commit.message}`);
    console.log(`  Files: ${commit.files.join(", ")}`);
    console.log(`  Category: ${commit.category}`);
    console.log("  Action: auto-drafting to inbox...");

    // Council fix S8: Use top-level imports, not dynamic import
    const item: InboxItem = {
      inbox_id: generateInboxId(),
      type: "draft_needed",
      created: new Date().toISOString(),
      commit_sha: commit.sha,
      commit_message: commit.message,
      change_category: commit.category,
      changed_files: commit.files,
      diff_summary: `Backfill from commit ${commit.sha.slice(0, 8)}`,
      priority: "normal",
      expires_after: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(),
      times_shown: 0,
      last_prompted_at: null,
      status: "pending",
    };
    await appendToInbox(item, projectRoot);
    captured++;
    console.log("");
    }
  }

  // Save backfill state for --resume
  const stateFile = join(ledgerDir(projectRoot), "backfill-state.json");
  if (remaining.length > 0) {
    await writeFile(stateFile, JSON.stringify({ remaining, savedAt: new Date().toISOString() }, null, 2), "utf8");
    console.log(`Backfill progress saved. ${remaining.length} commits remaining.`);
    console.log("Run 'context-ledger backfill --resume' to continue.");
  }

  console.log(`\nDrafted ${captured} inbox item(s). Use your MCP client to confirm or correct them.`);
}
```

**Git log parsing and structural commit classification:**

```typescript
interface BackfillCommit {
  sha: string;
  message: string;
  date: string;
  files: string[];
  category: string;
}

function parseGitLog(raw: string): BackfillCommit[] {
  // Council fix C3: NUL byte delimiter — safe for commit messages containing any character
  const commits: BackfillCommit[] = [];
  const lines = raw.split("\n");
  let current: BackfillCommit | null = null;

  for (const line of lines) {
    if (line.includes("\0")) {
      const parts = line.split("\0");
      if (parts.length >= 3) {
        if (current) commits.push(current);
        current = { sha: parts[0], message: parts[1], date: parts[2], files: [], category: "" };
      }
    } else if (line.trim() && current) {
      current.files.push(line.trim());
    }
  }
  if (current) commits.push(current);

  // Classify each commit
  for (const c of commits) {
    c.category = classifyCommit(c);
  }

  return commits;
}

function classifyCommit(commit: BackfillCommit): string {
  const { message, files } = commit;
  const msg = message.toLowerCase();

  // Tier 1 classifications (from design spec)
  if (files.some((f) => f === "package.json" || f === "package-lock.json")) return "dependency-change";
  if (files.some((f) => f.includes(".env"))) return "env-var-change";
  if (files.some((f) => f.match(/tsconfig|eslint|\.prettierrc|jest\.config|vitest|\.github/))) return "config-change";
  if (files.some((f) => f.match(/schema|migration|\.prisma|\.sql/))) return "schema-change";
  if (files.some((f) => f.match(/\/api\/|\/routes?\//))) return "api-route-change";

  // Structural signals
  if (msg.includes("delete") || msg.includes("remove") || msg.includes("drop")) return "removal";
  if (files.length >= 5) return "multi-file-change";

  return "other";
}

function isStructuralCommit(commit: BackfillCommit): boolean {
  const ignoredCategories = new Set(["other"]);
  return !ignoredCategories.has(commit.category);
}
```

### Step 5.2: backfill --resume

```typescript
async function resumeBackfill(): Promise<void> {
  const stateFile = join(ledgerDir(projectRoot), "backfill-state.json");
  let stateData: { remaining: string[]; savedAt: string };
  try {
    stateData = JSON.parse(await readFile(stateFile, "utf8"));
  } catch {
    console.error("No backfill session to resume. Run 'context-ledger backfill --max N' first.");
    process.exit(1);
  }

  if (!stateData.remaining || stateData.remaining.length === 0) {
    console.log("Previous backfill session is complete. No commits remaining.");
    return;
  }

  console.log(`Resuming backfill from ${stateData.savedAt}. ${stateData.remaining.length} commits remaining.\n`);

  // Re-read git log for just the remaining SHAs
  const maxIdx = args.indexOf("--max");
  const maxCommits = maxIdx >= 0 ? parseInt(args[maxIdx + 1], 10) : 5;
  const toProcess = stateData.remaining.slice(0, maxCommits);
  let captured = 0;

  for (const sha of toProcess) {
    let commitInfo: string;
    try {
      commitInfo = execSync(`git log -1 --format="%H%x00%s%x00%ai" --name-only ${sha}`, {
        cwd: projectRoot, encoding: "utf8",
      });
    } catch {
      console.error(`  Skipping ${sha.slice(0, 8)}: commit not found`);
      continue;
    }

    const parsed = parseGitLog(commitInfo);
    if (parsed.length === 0) continue;
    const commit = parsed[0];

    console.log(`Commit: ${commit.sha.slice(0, 8)} — ${commit.message}`);
    console.log(`  Files: ${commit.files.join(", ")}`);
    console.log(`  Category: ${commit.category}`);
    console.log("  Action: auto-drafting to inbox...");

    // Council fix S8: Use top-level imports
    const item: InboxItem = {
      inbox_id: generateInboxId(),
      type: "draft_needed",
      created: new Date().toISOString(),
      commit_sha: commit.sha,
      commit_message: commit.message,
      change_category: commit.category,
      changed_files: commit.files,
      diff_summary: `Backfill from commit ${commit.sha.slice(0, 8)}`,
      priority: "normal",
      expires_after: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(),
      times_shown: 0,
      last_prompted_at: null,
      status: "pending",
    };
    await appendToInbox(item, projectRoot);
    captured++;
    console.log("");
  }

  // Update state
  const remaining = stateData.remaining.slice(maxCommits);
  if (remaining.length > 0) {
    await writeFile(stateFile, JSON.stringify({ remaining, savedAt: new Date().toISOString() }, null, 2), "utf8");
    console.log(`${remaining.length} commits remaining. Run --resume again to continue.`);
  } else {
    // Clean up state file — import unlink from top-level node:fs/promises
    const { unlink } = await import("node:fs/promises");
    await unlink(stateFile).catch(() => {});
    console.log("Backfill complete! No commits remaining.");
  }

  console.log(`Drafted ${captured} inbox item(s).`);
}
```

### Validation Gate — Phase 5

```bash
npx tsc --noEmit

# backfill (should find structural commits)
node dist/cli.js backfill --max 2

# Check inbox grew
node dist/cli.js stats
```

**STOP AND REPORT:** Phase 5 complete. Backfill working. Proceed to Phase 6.

---

## Phase 6: Setup Delegation

**Files:** `src/cli.ts` (append handler)

### Step 6.1: setup command

Since `src/setup.ts` is a stub, the CLI should attempt dynamic import and gracefully handle failure:

```typescript
async function handleSetup(): Promise<void> {
  try {
    const setup = await import("./setup.js");
    if (typeof setup.default === "function") {
      await setup.default();
    } else if (typeof setup.runSetup === "function") {
      await setup.runSetup();
    } else {
      console.error("Setup wizard is not yet implemented.");
      console.error("Use 'context-ledger init' for basic initialization.");
      process.exit(1);
    }
  } catch {
    console.error("Setup wizard is not yet implemented.");
    console.error("Use 'context-ledger init' for basic initialization.");
    process.exit(1);
  }
}
```

### Validation Gate — Phase 6

```bash
npx tsc --noEmit

# setup (should print "not yet implemented")
node dist/cli.js setup
```

**STOP AND REPORT:** Phase 6 complete. All commands implemented.

---

## Phase 7: Final Validation

```bash
# Full build
npx tsc --noEmit

# All commands
node dist/cli.js --help
node dist/cli.js --version
node dist/cli.js stats
node dist/cli.js query "event sourcing"
node dist/cli.js export --format json | head -20
node dist/cli.js export --format csv | head -5
node dist/cli.js validate
node dist/cli.js validate --propose-repair
node dist/cli.js tidy
node dist/cli.js init
node dist/cli.js setup

# Verify no console.log leaks in serve mode (serve is the only command where stdout = JSON-RPC)
# Manual: run `node dist/cli.js serve` and verify only JSON-RPC output on stdout

# Unknown command
node dist/cli.js unknown-cmd; echo "exit code: $?"
# Should exit with code 1

# Council fix I2: Edge case smoke tests
# Empty/missing ledger — should print helpful message, not crash
mkdir /tmp/test-cli && cd /tmp/test-cli && node /path/to/dist/cli.js stats
# Should print "Run 'context-ledger init' first" (pre-flight check)

# Malformed JSONL
echo "not json" > .context-ledger/ledger.jsonl && node dist/cli.js validate
# Should report malformed line

# CSV on zero decisions
node dist/cli.js export --format csv
# Should print header only

# --format=json (equals syntax)
node dist/cli.js export --format=json | head -5

# agent-guard sync
npx agent-guard sync
```

**STOP AND REPORT:** All phases complete. CLI fully implemented.

---

## Key Design Decisions in This Guide

1. **mcp-server.ts refactor:** Extract `startMcpServer()` function rather than duplicating MCP setup in cli.ts. Avoids drift.
2. **searchDecisions for query command:** Design spec says "CLI/debugging only, lexical fallback" — `searchDecisions` is the correct function, not `queryDecisions`.
3. **Inline classification for backfill:** Since capture/classify.ts is a stub, implement lightweight Tier 1 classification in cli.ts. Can be migrated later.
4. **backfill-state.json for --resume:** Store in `.context-ledger/` alongside other state files. Contains array of remaining commit SHAs.
5. **Dynamic import for setup:** Graceful fallback since setup.ts is a stub. No hard dependency.
6. **validate uses foldLedger({ strict: false }):** Collects all warnings instead of throwing on first error. Additional fs.access() checks for stale file refs.
7. **mcp-server-bin.ts:** Separate bin wrapper instead of self-execution guard (Council C4).
8. **NUL-delimited git log:** Prevents commit message parsing bugs (Council C3).
9. **Directory-grouped backfill:** Groups by top-level directory for better UX (Council C2 partial).

---

## Refinement Log (Council Feedback Applied)

### Applied Fixes (Bucket 1)
- **C1:** Added decision_kind and verification_status to stats output
- **C2 (partial):** Backfill groups commits by top-level directory instead of flat chronological
- **C3:** Changed git log delimiter from "|" to NUL byte (\0) to handle pipe in commit messages
- **C4:** Replaced brittle argv[1] guard with export-only mcp-server.ts + separate bin wrapper
- **C6:** Added raw JSONL line-by-line validation before folding in validate command
- **S1:** Marked --apply-repair as "(not yet implemented)" in --help
- **S3:** Added getFlag() helper for --flag=value syntax support
- **S4:** Added pre-flight .context-ledger/ directory check for commands that need it
- **S7:** Added sub-command --help support
- **S8:** Removed dynamic imports in backfill, use top-level imports
- **I2:** Added edge case smoke tests to Phase 7

### Human Decisions Resolved (Bucket 2)
- **D1:** Option C — `--format json` for materialized state, `--format jsonl` for raw events
- **D3:** Option A — Stale file refs are warnings only, do not cause exit 1
- **D5:** Option A — Use `created` date for 30-day calculation, no schema change
