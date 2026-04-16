// context-ledger — capture/hook
// Post-commit hook entry point. Must complete under 100ms. Never blocks git commits.
// All output to stderr. Zero LLM calls. Zero network calls.

import { execFileSync, execSync } from "node:child_process";
import { stat } from "node:fs/promises";
import type { FoldedDecision, InboxItem, ProposedDecisionDraft } from "../ledger/index.js";
import { generateInboxId, appendToInbox, foldLedger, ledgerPath } from "../ledger/index.js";
import { loadConfig } from "../config.js";
import type { LedgerConfig } from "../config.js";
import { deriveScope } from "../retrieval/index.js";
import type { DerivedScope } from "../retrieval/index.js";
import { classifyCommit } from "./classify.js";
import type { ClassifyResult, ParsedPackageJson } from "./classify.js";
import { synthesizeDraft } from "./drafter.js";

// ── Debug ────────────────────────────────────────────────────────────────────

const DEBUG = !!process.env.CONTEXT_LEDGER_DEBUG;
function debug(msg: string): void {
  if (DEBUG) console.error(`[context-ledger] ${msg}`);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function redact(text: string, patterns: string[]): string {
  let result = text;
  for (const pat of patterns) {
    try {
      result = result.replace(new RegExp(pat, "g"), "[REDACTED]");
    } catch { /* invalid regex — skip */ }
  }
  return result;
}

function buildInboxItem(
  result: ClassifyResult,
  sha: string,
  redactedMessage: string,
  diffSummary: string,
  config: LedgerConfig,
  proposedDecision?: ProposedDecisionDraft,
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
    expires_after: new Date(Date.now() + config.capture.inbox_ttl_days * 24 * 60 * 60 * 1000).toISOString(),
    times_shown: 0,
    last_prompted_at: null,
    status: "pending",
  };
  if (proposedDecision) item.proposed_decision = proposedDecision;
  return item;
}

// ── Drafter helpers ──────────────────────────────────────────────────────────

const SENSITIVE_PATH_PATTERN = /(^|\/)(\.env($|\..+)|credentials(\..+)?|.+\.(key|pem))($|\/)/i;

function hasSensitivePath(files: string[]): boolean {
  return files.some((f) => SENSITIVE_PATH_PATTERN.test(f));
}

function getCommitDiff(projectRoot: string, sha: string, files: string[]): string {
  if (files.length === 0) return "";
  try {
    return execFileSync(
      "git",
      ["show", "--unified=3", "--no-color", sha, "--", ...files],
      { cwd: projectRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 16 * 1024 * 1024 },
    );
  } catch {
    return "";
  }
}

function precedentsForScope(
  decisions: Map<string, FoldedDecision>,
  scope: DerivedScope | null,
  limit = 10,
): Array<{ summary: string; decision: string }> {
  if (!scope) return [];
  const hits: Array<{ summary: string; decision: string; created: string }> = [];
  for (const folded of decisions.values()) {
    if (folded.state !== "active") continue;
    if (folded.record.verification_status !== "confirmed") continue;
    if (folded.record.scope.type !== scope.type || folded.record.scope.id !== scope.id) continue;
    hits.push({
      summary: folded.record.summary,
      decision: folded.record.decision,
      created: folded.record.created,
    });
  }
  hits.sort((a, b) => b.created.localeCompare(a.created));
  return hits.slice(0, limit).map(({ summary, decision }) => ({ summary, decision }));
}

function buildDiffSummary(
  result: ClassifyResult,
  extras?: { packageJsonDiff?: ParsedPackageJson | null; envVarChanges?: string[] | null },
): string {
  if (result.change_category === "dependency-addition" && extras?.packageJsonDiff?.addedDeps.length) {
    return `dependency-addition: +${extras.packageJsonDiff.addedDeps.join(", +")}`;
  }
  if (result.change_category === "dependency-removal" && extras?.packageJsonDiff?.removedDeps.length) {
    return `dependency-removal: -${extras.packageJsonDiff.removedDeps.join(", -")}`;
  }
  if (result.change_category === "env-var-change" && extras?.envVarChanges?.length) {
    return `env-var-change: ${extras.envVarChanges.join(", ")}`;
  }

  const files = result.changed_files;
  if (files.length === 1) return `${result.change_category}: ${files[0]}`;
  const dirs = [...new Set(files.map((f) => f.split("/").slice(0, -1).join("/")))];
  if (dirs.length === 1) return `${result.change_category}: ${files.length} files in ${dirs[0]}/`;
  return `${result.change_category}: ${files.length} files across ${dirs.length} directories`;
}

function isMergeCommit(projectRoot: string): boolean {
  try {
    execSync("git rev-parse HEAD^2", { cwd: projectRoot, encoding: "utf8", stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

// ── Git Output Parsing ───────────────────────────────────────────────────────

interface ParsedDiff {
  all: string[];
  added: string[];
  deleted: string[];
  modified: string[];
  renamed: Array<{ from: string; to: string }>;
}

function parseNameStatus(raw: string): ParsedDiff {
  const result: ParsedDiff = { all: [], added: [], deleted: [], modified: [], renamed: [] };
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

// ── Content Parsers ──────────────────────────────────────────────────────────

function parsePackageJsonDiff(projectRoot: string): ParsedPackageJson | null {
  try {
    const current = JSON.parse(
      execSync("git show HEAD:package.json", { cwd: projectRoot, encoding: "utf8", stdio: "pipe" }),
    );
    let previous: Record<string, unknown> = {};
    try {
      previous = JSON.parse(
        execSync("git show HEAD~1:package.json", { cwd: projectRoot, encoding: "utf8", stdio: "pipe" }),
      );
    } catch { /* initial commit or file didn't exist */ }

    const currentDeps: Record<string, string> = {
      ...(current.dependencies as Record<string, string> | undefined),
      ...(current.devDependencies as Record<string, string> | undefined),
    };
    const prevDeps: Record<string, string> = {
      ...(previous.dependencies as Record<string, string> | undefined),
      ...(previous.devDependencies as Record<string, string> | undefined),
    };

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

function parseEnvChanges(projectRoot: string): string[] | null {
  try {
    const current = execSync("git show HEAD:.env.example", { cwd: projectRoot, encoding: "utf8", stdio: "pipe" });
    let previous = "";
    try {
      previous = execSync("git show HEAD~1:.env.example", { cwd: projectRoot, encoding: "utf8", stdio: "pipe" });
    } catch { /* file didn't exist before */ }

    const parseVars = (text: string) =>
      text.split("\n").filter((l) => l.includes("=") && !l.startsWith("#")).map((l) => l.split("=")[0].trim());
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

// ── Path Normalization ───────────────────────────────────────────────────────

function normalizePath(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "");
}

// ── Main Entry Point ─────────────────────────────────────────────────────────

export async function postCommit(): Promise<void> {
  try {
    // 1. Resolve projectRoot
    const projectRoot = process.env.CONTEXT_LEDGER_PROJECT_ROOT ?? process.cwd();
    debug(`projectRoot: ${projectRoot}`);

    // 2. Load config + check enabled
    const config = await loadConfig(projectRoot);
    if (!config.capture.enabled) {
      debug("capture disabled");
      return;
    }

    // 3. Get commit info (message first for early exit)
    const sha = execSync("git rev-parse HEAD", { cwd: projectRoot, encoding: "utf8", stdio: "pipe" }).trim();
    const subject = execSync("git log -1 --format=%s HEAD", { cwd: projectRoot, encoding: "utf8", stdio: "pipe" }).trim();
    const fullBody = execSync("git log -1 --format=%B HEAD", { cwd: projectRoot, encoding: "utf8", stdio: "pipe" }).trim();

    // 4. Check no_capture_marker in full body
    if (fullBody.includes(config.capture.no_capture_marker)) {
      debug("no_capture_marker found, skipping");
      return;
    }

    // 5. Skip merge commits
    if (isMergeCommit(projectRoot)) {
      debug("merge commit, skipping");
      return;
    }

    // 6. Get changed files via single consolidated git command
    let raw: string;
    try {
      raw = execSync("git diff-tree --no-commit-id --root -r --name-status -z HEAD", { cwd: projectRoot, encoding: "utf8", stdio: "pipe" });
    } catch {
      debug("git diff-tree failed");
      return;
    }
    const diff = parseNameStatus(raw);
    if (diff.all.length === 0) {
      debug("empty commit, skipping");
      return;
    }

    // 7. Normalize all paths immediately
    diff.all = diff.all.map(normalizePath);
    diff.added = diff.added.map(normalizePath);
    diff.deleted = diff.deleted.map(normalizePath);
    diff.modified = diff.modified.map(normalizePath);
    diff.renamed = diff.renamed.map((r) => ({ from: normalizePath(r.from), to: normalizePath(r.to) }));

    // 8. Parse high-value file diffs + classify
    const pkgDiff = diff.all.some((f) => f.endsWith("package.json"))
      ? parsePackageJsonDiff(projectRoot)
      : null;

    const envChanges = diff.all.some((f) => f.includes(".env"))
      ? parseEnvChanges(projectRoot)
      : null;

    const results = classifyCommit(diff.all, diff.deleted, diff.added, subject, config, pkgDiff);
    if (results.length === 0) {
      debug("no actionable classifications");
      return;
    }
    debug(`classified: ${results.length} results`);

    // 9. Tier 2 contradiction detection — best effort.
    //    Also reuse the folded state for the drafter's precedent lookup.
    let foldedState: Awaited<ReturnType<typeof foldLedger>> | null = null;
    try {
      const ledgerFile = ledgerPath(projectRoot);
      const stats = await stat(ledgerFile).catch(() => null);
      if (stats && stats.size < 100 * 1024) {
        foldedState = await foldLedger(projectRoot);
        for (let i = 0; i < results.length; i++) {
          const r = results[i];
          if (r.tier === 1) {
            for (const f of r.changed_files) {
              const derived = deriveScope({ file_path: f }, config, foldedState.decisions);
              if (derived) {
                for (const [, folded] of foldedState.decisions) {
                  if (
                    folded.state === "active" &&
                    folded.record.scope.type === derived.type &&
                    folded.record.scope.id === derived.id
                  ) {
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
              if (results[i].tier === 2) break;
            }
          }
        }
      }
    } catch {
      debug("Tier 2 contradiction detection failed, continuing with Tier 1");
    }

    // 10. Build diff_summary FIRST, then redact BOTH
    const redactedMessage = redact(subject, config.capture.redact_patterns);
    const extras = { packageJsonDiff: pkgDiff, envVarChanges: envChanges };

    const drafterEnabled = config.capture.drafter.enabled !== false;
    const apiKey = process.env.ANTHROPIC_API_KEY ?? null;
    let drafterSkipLoggedForMissingKey = false;

    for (const result of results) {
      const rawSummary = buildDiffSummary(result, extras);
      const redactedSummary = redact(rawSummary, config.capture.redact_patterns);

      let proposed: ProposedDecisionDraft | undefined;

      if (result.inbox_type === "draft_needed" && drafterEnabled) {
        if (!apiKey) {
          if (!drafterSkipLoggedForMissingKey) {
            console.error(
              "[context-ledger:drafter] ANTHROPIC_API_KEY not set — skipping draft synthesis",
            );
            drafterSkipLoggedForMissingKey = true;
          }
        } else if (hasSensitivePath(result.changed_files)) {
          console.error(
            "[context-ledger:drafter] sensitive path detected in changed files — skipping draft",
          );
        } else {
          const derived = deriveScope(
            { file_path: result.changed_files[0] },
            config,
            foldedState?.decisions ?? new Map(),
          );
          const precedents = precedentsForScope(
            foldedState?.decisions ?? new Map(),
            derived,
          );
          const rawDiff = getCommitDiff(projectRoot, sha, result.changed_files);
          const draft = await synthesizeDraft({
            commitSha: sha,
            commitMessage: fullBody,
            changeCategory: result.change_category,
            changedFiles: result.changed_files,
            diff: rawDiff,
            existingPrecedents: precedents,
            config: {
              apiKey,
              model: config.capture.drafter.model,
              timeoutMs: config.capture.drafter.timeout_ms,
              maxDiffChars: config.capture.drafter.max_diff_chars,
            },
          });
          if (draft) proposed = draft;
        }
      }

      const item = buildInboxItem(result, sha, redactedMessage, redactedSummary, config, proposed);
      await appendToInbox(item, projectRoot);
      console.error(
        `[context-ledger] Captured ${result.change_category} (${result.inbox_type})${proposed ? " +draft" : ""}`,
      );
    }
  } catch (err: unknown) {
    debug(`Hook error (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ── Self-invocation guard ────────────────────────────────────────────────────

const isDirectRun = process.argv[1]?.endsWith("hook.js") || process.argv[1]?.endsWith("hook.ts");
if (isDirectRun) {
  postCommit().catch(() => {});
}
