#!/usr/bin/env node
// context-ledger — CLI entry point
// All command output goes to stdout. Diagnostics and errors to stderr.

import { readFile, mkdir, writeFile, access, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";

// Internal imports — all .js extensions
import { DEFAULT_CONFIG, loadConfig } from "./config.js";
import {
  readLedger, readInbox, rewriteInbox, foldLedger,
  LedgerIntegrityError, ledgerDir, ledgerPath, inboxPath, configPath,
  isDecisionRecord, isTransitionEvent,
  generateDecisionId, generateInboxId, appendToLedger, appendToInbox,
  tidyInbox,
  validateLedger, proposeRepair,
} from "./ledger/index.js";
import type {
  LifecycleState,
  DecisionRecord, InboxItem, EvidenceType, Durability,
  ProposedDecisionDraft,
} from "./ledger/index.js";
import { queryDecisions } from "./retrieval/index.js";
import { startMcpServer } from "./mcp-server.js";
import { detectHookSystem } from "./capture/detect-hooks.js";
import { runSetupWizard } from "./setup.js";

// ── Argv Parsing ──────────────────────────────────────────────────────────────

const projectRoot = process.env.CONTEXT_LEDGER_PROJECT_ROOT ?? process.cwd();
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

// ── Pre-flight ────────────────────────────────────────────────────────────────

const NEEDS_LEDGER = new Set(["query", "stats", "export", "validate", "tidy", "backfill", "capture"]);

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

// ── Command Dispatch ──────────────────────────────────────────────────────────

async function main(): Promise<void> {
  await ensureLedgerExists();

  switch (command) {
    case "init": return handleInit();
    case "serve": return handleServe();
    case "query": return handleQuery();
    case "stats": return handleStats();
    case "export": return handleExport();
    case "validate": return handleValidate();
    case "tidy": return handleTidy();
    case "backfill": return handleBackfill();
    case "capture": return handleCapture();
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

// ── Help & Version ────────────────────────────────────────────────────────────

function printHelp(): void {
  console.log(`Usage: context-ledger <command> [options]

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
  capture '<summary>'           Capture a convention or decision manually
  setup                         Run interactive setup wizard

Options:
  --help, -h                    Show this help
  --version, -v                 Show version

Use 'context-ledger <command> --help' for command-specific help.`);
}

async function printVersion(): Promise<void> {
  const __dirname = fileURLToPath(new URL(".", import.meta.url));
  const pkgPath = join(__dirname, "..", "package.json");
  const pkg = JSON.parse(await readFile(pkgPath, "utf8"));
  console.log(`context-ledger v${pkg.version}`);
}

// ── serve ─────────────────────────────────────────────────────────────────────

async function handleServe(): Promise<void> {
  await startMcpServer(projectRoot);
}

// ── query ─────────────────────────────────────────────────────────────────────

async function handleQuery(): Promise<void> {
  if (hasFlag("--help")) {
    console.log(`Usage: context-ledger query <text>
  Returns the full decision pack for the query: prior mistakes in scope,
  active precedents, abandoned approaches, recently superseded, and pending inbox items.
  This mirrors what the agent sees over MCP query_decisions.`);
    return;
  }

  const queryText = args.slice(1).join(" ");
  if (!queryText) {
    console.error("Usage: context-ledger query <text>");
    process.exit(1);
  }

  const pack = await queryDecisions({ query: queryText }, projectRoot);

  // Section 1 — Prior mistakes in this scope (rendered FIRST per spec).
  if (pack.mistakes_in_scope.length > 0) {
    console.log(`\nPrior mistakes in this scope (${pack.mistakes_in_scope.length}):\n`);
    for (const m of pack.mistakes_in_scope) {
      switch (m.kind) {
        case "superseded_with_pain_points":
          console.log(`  [superseded] ${m.record.id}  → replaced_by ${m.replaced_by}`);
          console.log(`    ${m.record.summary}`);
          for (const pp of m.pain_points) console.log(`    pain: ${pp}`);
          break;
        case "abandoned":
          console.log(`  [abandoned]  ${m.record.id}`);
          console.log(`    ${m.record.summary}`);
          if (m.reason) console.log(`    reason: ${m.reason}`);
          for (const pp of m.pain_points) console.log(`    pain: ${pp}`);
          break;
        case "rejected_inbox_item":
          console.log(`  [rejected]   ${m.inbox_id}  ${m.commit_sha.slice(0, 7)}`);
          console.log(`    ${m.commit_message}`);
          console.log(`    rejection: ${m.rejection_reason}`);
          break;
        default: {
          const _exhaustive: never = m;
          throw new Error(`Unhandled MistakeEntry kind: ${JSON.stringify(_exhaustive)}`);
        }
      }
    }
  }

  // Section 2 — Active precedents.
  if (pack.active_precedents.length > 0) {
    console.log(`\nActive precedents (${pack.active_precedents.length}):\n`);
    for (const p of pack.active_precedents) {
      const flags: string[] = [p.match_reason];
      if (p.review_overdue) flags.push("review_overdue");
      console.log(`  [active]     ${p.record.id}  weight=${p.retrieval_weight.toFixed(2)}  ${flags.join(" ")}`);
      console.log(`    ${p.record.summary}`);
      console.log(`    scope: ${p.record.scope.type}/${p.record.scope.id}  kind: ${p.record.decision_kind}  durability: ${p.record.durability}`);
    }
  }

  // Section 3 — Abandoned approaches (legacy bucket; may overlap with mistakes).
  if (pack.abandoned_approaches.length > 0) {
    console.log(`\nAbandoned approaches (${pack.abandoned_approaches.length}):\n`);
    for (const a of pack.abandoned_approaches) {
      console.log(`  [abandoned]  ${a.record.id}  ${a.match_reason}`);
      console.log(`    ${a.record.summary}`);
      for (const pp of a.pain_points) console.log(`    pain: ${pp}`);
    }
  }

  // Section 4 — Recently superseded (only populated with include_superseded=true).
  if (pack.recently_superseded.length > 0) {
    console.log(`\nRecently superseded (${pack.recently_superseded.length}):\n`);
    for (const s of pack.recently_superseded) {
      console.log(`  [superseded] ${s.record.id}  → ${s.replaced_by}`);
      console.log(`    ${s.record.summary}`);
    }
  }

  // Section 5 — Pending inbox items.
  if (pack.pending_inbox_items.length > 0) {
    console.log(`\nPending inbox items (${pack.pending_inbox_items.length}):\n`);
    for (const i of pack.pending_inbox_items) {
      console.log(`  [${i.type}] ${i.inbox_id}  ${i.commit_sha.slice(0, 7)}  ${i.change_category}`);
      console.log(`    ${i.commit_message}`);
      const draft = i.proposed_record ?? (i as unknown as { proposed_decision?: ProposedDecisionDraft }).proposed_decision;
      if (draft?.scope_type && draft?.scope_id) {
        console.log(`    scope: ${draft.scope_type}/${draft.scope_id}`);
      }
    }
  }

  // Footer.
  const derived = pack.derived_scope
    ? `${pack.derived_scope.type}/${pack.derived_scope.id} (source: ${pack.derived_scope.source})`
    : "null (recency fallback)";
  console.log(`\n— derived_scope: ${derived}`);
  console.log(`— token_estimate: ${pack.token_estimate}${pack.truncated ? "  (truncated)" : ""}`);
  if (pack.no_precedent_scopes.length > 0) {
    console.log(`— no_precedent_scopes: ${pack.no_precedent_scopes.join(", ")}`);
  }

  const empty =
    pack.mistakes_in_scope.length === 0 &&
    pack.active_precedents.length === 0 &&
    pack.abandoned_approaches.length === 0 &&
    pack.recently_superseded.length === 0 &&
    pack.pending_inbox_items.length === 0;
  if (empty) console.log("\nNo matching decisions found.");
}

// ── stats ─────────────────────────────────────────────────────────────────────

async function handleStats(): Promise<void> {
  if (hasFlag("--help")) {
    console.log(`Usage: context-ledger stats
  Shows decision counts by source, kind, scope, evidence type,
  verification status, state, and durability. Also shows inbox status.`);
    return;
  }

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
  // Bonus groupings
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

// ── export ────────────────────────────────────────────────────────────────────

async function handleExport(): Promise<void> {
  if (hasFlag("--help")) {
    console.log(`Usage: context-ledger export --format <json|csv|jsonl>
  --format json    Output materialized decisions as JSON array
  --format csv     Output decisions as CSV with header row
  --format jsonl   Output raw ledger events as JSON array`);
    return;
  }

  const format = getFlag("--format");

  if (!format || !["json", "csv", "jsonl"].includes(format)) {
    console.error("Usage: context-ledger export --format json|csv|jsonl");
    process.exit(1);
  }

  if (format === "jsonl") {
    // Raw ledger events as JSON array
    const events = await readLedger(projectRoot);
    console.log(JSON.stringify(events, null, 2));
    return;
  }

  const state = await foldLedger(projectRoot);
  const decisions = Array.from(state.decisions.values());

  if (format === "json") {
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

// ── validate ──────────────────────────────────────────────────────────────────

async function handleValidate(): Promise<void> {
  if (args[1] === "--help") {
    console.log(`Usage: context-ledger validate [--propose-repair | --apply-repair]
  Checks ledger integrity: malformed JSONL, orphaned transitions,
  illegal lifecycle states, stale file references (warnings only).
  --propose-repair  Suggest repairs without modifying files
  --apply-repair    Apply repair plan (not yet implemented)`);
    return;
  }

  const subcommand = args[1];

  if (subcommand === "--propose-repair") {
    const plan = await proposeRepair(projectRoot);
    const { errors, warnings } = plan.report;

    if (errors.length === 0 && warnings.length === 0 && plan.actions.length === 0) {
      console.log("No issues or repair suggestions found.");
      return;
    }

    if (errors.length > 0) {
      console.log(`Issues (${errors.length}):`);
      for (const e of errors) console.log(`  - ${e}`);
      console.log("");
    }

    if (warnings.length > 0) {
      console.log(`Warnings (${warnings.length}):`);
      for (const w of warnings) console.log(`  - ${w}`);
      console.log("");
    }

    if (plan.actions.length > 0) {
      console.log(`Repair Suggestions (${plan.actions.length}):`);
      for (const a of plan.actions) console.log(`  - ${a.type.toUpperCase()}: ${a.message}`);
    }
    return;
  }

  if (subcommand === "--apply-repair") {
    console.error("validate --apply-repair is not yet implemented.");
    console.error("Use --propose-repair to generate a repair plan first.");
    process.exit(1);
  }

  // Default: validate and report
  const report = await validateLedger(projectRoot);

  if (report.warnings.length > 0) {
    console.log(`Warnings (${report.warnings.length}):`);
    for (const w of report.warnings) console.log(`  - ${w}`);
    console.log("");
  }

  if (report.passed) {
    console.log(`Ledger integrity check passed.${report.warnings.length > 0 ? ` ${report.warnings.length} warning(s).` : " No issues found."}`);
    return;
  }

  console.log(`Errors (${report.errors.length}):`);
  for (const e of report.errors) {
    console.log(`  - ${e}`);
  }
  process.exit(1);
}

// ── init ──────────────────────────────────────────────────────────────────────

async function handleInit(): Promise<void> {
  if (hasFlag("--help")) {
    console.log(`Usage: context-ledger init
  Creates .context-ledger/ directory, default config.json,
  and installs the post-commit hook.`);
    return;
  }

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

async function installPostCommitHook(): Promise<void> {
  const hookScript = `#!/bin/sh
# context-ledger post-commit hook
# Instantaneous, deterministic — zero LLM calls, zero network calls.
node -e "import('@mossrussell/context-ledger/dist/capture/hook.js').then(m => m.postCommit()).catch(() => {})" 2>/dev/null || true
`;

  const marker = "context-ledger";
  const result = await detectHookSystem(projectRoot);

  switch (result.system) {
    case "husky": {
      const hookPath = result.hookPath!;
      if (result.alreadyInstalled) {
        console.log("Husky post-commit hook already contains context-ledger, skipping.");
        return;
      }
      try {
        const existing = await readFile(hookPath, "utf8");
        if (!existing.includes(marker)) {
          await writeFile(hookPath, existing.trimEnd() + "\n\n" + hookScript, { mode: 0o755 });
          console.log("Appended context-ledger to existing .husky/post-commit");
        }
      } catch {
        await writeFile(hookPath, hookScript, { mode: 0o755 });
        console.log("Installed post-commit hook via Husky (.husky/post-commit)");
      }
      break;
    }
    case "lefthook": {
      console.log("Lefthook detected. Add the following to your lefthook.yml:");
      console.log('  post-commit:\n    commands:\n      context-ledger:\n        run: node -e "import(\'@mossrussell/context-ledger/dist/capture/hook.js\').then(m => m.postCommit()).catch(() => {})"');
      break;
    }
    case "simple-git-hooks": {
      console.log("simple-git-hooks detected. Add to package.json:");
      console.log('  "simple-git-hooks": { "post-commit": "node -e \\"import(\'@mossrussell/context-ledger/dist/capture/hook.js\').then(m => m.postCommit()).catch(() => {})\\"" }');
      break;
    }
    case "bare": {
      const hookPath = result.hookPath!;
      if (result.alreadyInstalled) {
        console.log("post-commit hook already contains context-ledger, skipping.");
        return;
      }
      try {
        const existing = await readFile(hookPath, "utf8");
        if (!existing.includes(marker)) {
          await writeFile(hookPath, existing.trimEnd() + "\n\n" + hookScript, { mode: 0o755 });
          console.log("Appended context-ledger to existing .git/hooks/post-commit");
        }
      } catch {
        await writeFile(hookPath, hookScript, { mode: 0o755 });
        console.log("Installed post-commit hook to .git/hooks/post-commit");
      }
      break;
    }
    case "none": {
      console.error("Warning: Could not find .git/hooks/ directory. Hook not installed.");
      console.error("Run 'context-ledger init' from your git repository root.");
      break;
    }
  }
}

// ── tidy ──────────────────────────────────────────────────────────────────────

async function handleTidy(): Promise<void> {
  if (hasFlag("--help")) {
    console.log(`Usage: context-ledger tidy
  Removes terminal inbox entries (dismissed/expired/ignored)
  older than 30 days. Also expires TTL and max-prompt items.`);
    return;
  }

  const { removed, remaining } = await tidyInbox(projectRoot);

  if (removed === 0) {
    console.log("No stale inbox entries to remove.");
    return;
  }

  console.log(`Removed ${removed} stale inbox entries. ${remaining} entries remaining.`);
}

// ── backfill ──────────────────────────────────────────────────────────────────

interface BackfillCommit {
  sha: string;
  message: string;
  date: string;
  files: string[];
  category: string;
}

function parseGitLog(raw: string): BackfillCommit[] {
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
  if (files.some((f) => /tsconfig|eslint|\.prettierrc|jest\.config|vitest|\.github/.test(f))) return "config-change";
  if (files.some((f) => /schema|migration|\.prisma|\.sql/.test(f))) return "schema-change";
  if (files.some((f) => /\/api\/|\/routes?\//.test(f))) return "api-route-change";

  // Structural signals
  if (msg.includes("delete") || msg.includes("remove") || msg.includes("drop")) return "removal";
  if (files.length >= 5) return "multi-file-change";

  return "other";
}

function isStructuralCommit(commit: BackfillCommit): boolean {
  return commit.category !== "other";
}

async function handleBackfill(): Promise<void> {
  if (hasFlag("--help")) {
    console.log(`Usage: context-ledger backfill [--max <N>] [--resume]
  --max <N>   Process up to N structural commits (default 5)
  --resume    Resume a previously interrupted backfill session`);
    return;
  }

  const isResume = args.includes("--resume");
  const maxStr = getFlag("--max");
  const maxCommits = maxStr ? parseInt(maxStr, 10) : 5;

  if (isNaN(maxCommits) || maxCommits < 1) {
    console.error("Usage: context-ledger backfill --max <N> (N must be a positive integer)");
    process.exit(1);
  }

  if (isResume) {
    return resumeBackfill(maxCommits);
  }

  // Get structural commits from last 90 days
  const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
  let gitLog: string;
  try {
    gitLog = execSync(
      `git log --since="${ninetyDaysAgo}" --format="%H%x00%s%x00%ai" --diff-filter=ADRC --name-only`,
      { cwd: projectRoot, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 }
    );
  } catch {
    console.error("Failed to read git log. Are you in a git repository?");
    process.exit(1);
  }

  const commits = parseGitLog(gitLog);
  const structural = commits.filter((c) => isStructuralCommit(c));

  if (structural.length === 0) {
    console.log("No structural commits found in the last 90 days.");
    return;
  }

  // Council fix C2 (partial): Group by top-level directory
  const byDirectory = new Map<string, BackfillCommit[]>();
  for (const c of structural) {
    const dir = c.files.length > 0 ? c.files[0].split("/")[0] : "root";
    if (!byDirectory.has(dir)) byDirectory.set(dir, []);
    byDirectory.get(dir)!.push(c);
  }

  console.log(`Found ${structural.length} structural commit(s) in ${byDirectory.size} area(s). Processing up to ${maxCommits}.\n`);

  let captured = 0;
  const remaining: string[] = [];

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

async function resumeBackfill(maxCommits: number): Promise<void> {
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
  const remainingShas = stateData.remaining.slice(maxCommits);
  if (remainingShas.length > 0) {
    await writeFile(stateFile, JSON.stringify({ remaining: remainingShas, savedAt: new Date().toISOString() }, null, 2), "utf8");
    console.log(`${remainingShas.length} commits remaining. Run --resume again to continue.`);
  } else {
    await unlink(stateFile).catch(() => {});
    console.log("Backfill complete! No commits remaining.");
  }

  console.log(`Drafted ${captured} inbox item(s).`);
}

// ── capture ───────────────────────────────────────────────────────────────────

async function handleCapture(): Promise<void> {
  if (hasFlag("--help")) {
    console.log(`Usage: context-ledger capture '<summary>'
  Interactively capture a convention or architectural decision.
  Writes directly to the ledger as source: manual, evidence_type: explicit_manual.

  Example:
    context-ledger capture 'All API responses use COALESCE with sensible defaults'`);
    return;
  }

  const summary = args.slice(1).filter((a) => !a.startsWith("--")).join(" ");
  if (!summary) {
    console.error("Usage: context-ledger capture '<summary>'");
    console.error("Example: context-ledger capture 'Use COALESCE with sensible defaults for nullable columns'");
    process.exit(1);
  }

  if (!process.stdin.isTTY) {
    console.error("Error: capture requires an interactive terminal.");
    console.error("Run this command directly (not piped) so you can answer the prompts.");
    process.exit(1);
  }

  const rl = createInterface({ input: process.stdin, output: process.stderr });

  try {
    console.error(`\nCapturing decision: "${summary}"\n`);

    const decision = await rl.question("Decision (what was decided, in detail):\n> ");
    const rationale = await rl.question("\nRationale (why this approach):\n> ");

    const altInput = await rl.question("\nAlternatives considered (comma-separated, or empty to skip):\n> ");
    const alternatives = altInput.trim()
      ? altInput.split(",").map((a) => ({
          approach: a.trim(),
          why_rejected: "Not specified",
          failure_conditions: null,
        }))
      : [];

    const revisit = await rl.question("\nRevisit conditions (when to reconsider, or empty):\n> ");

    const scopeType = await rl.question("\nScope type (package, directory, domain, concern, integration) [domain]:\n> ") || "domain";
    const scopeId = await rl.question("Scope ID (e.g. 'query-layer', 'auth', 'ledger-core'):\n> ");
    if (!scopeId) {
      console.error("Scope ID is required.");
      process.exit(1);
    }

    const kind = await rl.question("\nDecision kind (e.g. 'convention', 'pattern', 'constraint') [convention]:\n> ") || "convention";
    const durability = await rl.question("Durability (precedent, feature-local, temporary-workaround) [precedent]:\n> ") || "precedent";

    const filesInput = await rl.question("\nAffected files (comma-separated paths, or empty):\n> ");
    const affectedFiles = filesInput.trim() ? filesInput.split(",").map((f) => f.trim()) : [];

    const tagsInput = await rl.question("Tags (comma-separated, or empty):\n> ");
    const tags = tagsInput.trim() ? tagsInput.split(",").map((t) => t.trim()) : [];

    const record: DecisionRecord = {
      type: "decision",
      id: generateDecisionId(),
      created: new Date().toISOString(),
      source: "manual",
      evidence_type: "explicit_manual",
      verification_status: "confirmed",
      commit_sha: null,
      summary,
      decision: decision || summary,
      alternatives_considered: alternatives,
      rationale: rationale || "Not specified",
      revisit_conditions: revisit || "",
      review_after: durability === "temporary-workaround"
        ? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
        : null,
      scope: { type: scopeType as any, id: scopeId },
      affected_files: affectedFiles,
      scope_aliases: [],
      decision_kind: kind,
      tags,
      durability: durability as any,
    };

    await appendToLedger(record, projectRoot);

    console.log(`\nDecision captured: ${record.id}`);
    console.log(`  Summary: ${summary}`);
    console.log(`  Scope: ${scopeType}/${scopeId}`);
    console.log(`  Durability: ${durability}`);
    console.log(`  Evidence: explicit_manual (weight 1.0)`);
  } finally {
    rl.close();
  }
}

// ── setup ─────────────────────────────────────────────────────────────────────

async function handleSetup(): Promise<void> {
  await runSetupWizard(projectRoot);
}

// ── Entry Point ───────────────────────────────────────────────────────────────

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
