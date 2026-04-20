// context-ledger — hook integration tests
// Standalone script: exit 0 on pass, 1 on fail.
// Spins up a temp git repo, mocks Anthropic SDK, runs postCommit(), and
// inspects inbox.jsonl to verify proposed_record presence/absence.

import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import type { InboxItem } from "../ledger/index.js";
import { inboxPath, configPath } from "../ledger/index.js";
import { postCommit } from "./hook.js";

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

// ── SDK mock harness ─────────────────────────────────────────────────────────

type CreateFn = (...args: unknown[]) => Promise<unknown>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const MessagesCtor = (Anthropic as any).Messages as { prototype: { create: CreateFn } };
const originalCreate = MessagesCtor.prototype.create;

function installMock(fn: CreateFn): void {
  MessagesCtor.prototype.create = async function (...args: unknown[]) {
    return fn(...args);
  };
}

function restoreMock(): void {
  MessagesCtor.prototype.create = originalCreate;
}

function mockSuccessResponse(): unknown {
  return {
    id: "msg_t",
    type: "message",
    role: "assistant",
    model: "claude-haiku-4-5-20251001",
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
    content: [
      {
        type: "tool_use",
        id: "tool_t",
        name: "propose_decision",
        input: {
          summary: "Introduce auth module skeleton",
          decision: "Add src/auth/ with a single hash module stub.",
          rationale: "Sets aside a landing place for password hashing code so later commits can fill it.",
          alternatives_considered: [],
          decision_kind: "module-boundary",
          tags: ["auth", "scaffolding"],
          durability: "feature-local",
        },
      },
    ],
  };
}

// ── Git repo bootstrap ───────────────────────────────────────────────────────

async function bootstrapRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "cl-hook-test-"));
  const git = (args: string[]) =>
    execFileSync("git", args, { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
  git(["init", "-q"]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "Test"]);
  git(["config", "commit.gpgsign", "false"]);
  // Seed commit so HEAD~1 exists for hook's parent-lookup paths.
  await writeFile(join(dir, "README.md"), "# test\n", "utf8");
  git(["add", "README.md"]);
  git(["commit", "-q", "-m", "initial"]);
  await mkdir(join(dir, ".context-ledger"), { recursive: true });
  return dir;
}

async function writeConfig(root: string, drafterEnabled: boolean): Promise<void> {
  const cfg = {
    capture: {
      enabled: true,
      ignore_paths: ["dist/", "node_modules/"],
      scope_mappings: {},
      redact_patterns: [],
      no_capture_marker: "[no-capture]",
      inbox_ttl_days: 14,
      inbox_max_prompts_per_item: 3,
      inbox_max_items_per_session: 3,
      drafter: { enabled: drafterEnabled },
    },
  };
  await writeFile(configPath(root), JSON.stringify(cfg, null, 2), "utf8");
}

async function commitNewAuthDir(root: string): Promise<void> {
  const git = (args: string[]) =>
    execFileSync("git", args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  await mkdir(join(root, "src", "newmodule"), { recursive: true });
  // Use non-auth name so we hit the Tier 1 "new-directory" (draft_needed) path
  // rather than Tier 2 auth-security-change (question_needed).
  await writeFile(join(root, "src", "newmodule", "index.ts"), "export const a = 1;\n", "utf8");
  await writeFile(join(root, "src", "newmodule", "helpers.ts"), "export const b = 2;\n", "utf8");
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "feat: introduce new module skeleton"]);
}

async function readInboxItems(root: string): Promise<InboxItem[]> {
  const content = await readFile(inboxPath(root), "utf8").catch(() => "");
  return content
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l) as InboxItem);
}

async function runPostCommitIn(root: string): Promise<void> {
  const prevCwd = process.env.CONTEXT_LEDGER_PROJECT_ROOT;
  process.env.CONTEXT_LEDGER_PROJECT_ROOT = root;
  try {
    await postCommit();
  } finally {
    if (prevCwd === undefined) delete process.env.CONTEXT_LEDGER_PROJECT_ROOT;
    else process.env.CONTEXT_LEDGER_PROJECT_ROOT = prevCwd;
  }
}

// ── Test 5: drafter returns a draft → inbox item has proposed_record ──────

async function test5WithDraft(): Promise<void> {
  console.error("\nTest 5: drafter returns draft → inbox item includes proposed_record");
  installMock(async () => mockSuccessResponse());
  const prevKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "sk-mock";

  const root = await bootstrapRepo();
  try {
    await writeConfig(root, true);
    await commitNewAuthDir(root);
    await runPostCommitIn(root);

    const items = await readInboxItems(root);
    assert(items.length >= 1, `wrote at least one inbox item (got ${items.length})`);
    const draftNeeded = items.find((i) => i.type === "draft_needed");
    assert(draftNeeded !== undefined, "a draft_needed item was created");
    if (draftNeeded) {
      assert(
        draftNeeded.proposed_record !== undefined,
        "draft_needed item carries proposed_record",
      );
      if (draftNeeded.proposed_record) {
        assert(
          typeof draftNeeded.proposed_record.summary === "string" &&
            draftNeeded.proposed_record.summary.length > 0,
          "proposed_record.summary is non-empty",
        );
        assert(
          draftNeeded.proposed_record.durability === "feature-local",
          "proposed_record.durability matches mock",
        );
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
    if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = prevKey;
    restoreMock();
  }
}

// ── Test 6: no API key → inbox item written WITHOUT proposed_record ───────

async function test6WithoutDraft(): Promise<void> {
  console.error("\nTest 6: no API key → inbox item has no proposed_record");
  let called = false;
  installMock(async () => {
    called = true;
    return mockSuccessResponse();
  });
  const prevKey = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;

  const root = await bootstrapRepo();
  try {
    await writeConfig(root, true);
    await commitNewAuthDir(root);
    await runPostCommitIn(root);

    const items = await readInboxItems(root);
    assert(items.length >= 1, `wrote at least one inbox item (got ${items.length})`);
    const draftNeeded = items.find((i) => i.type === "draft_needed");
    assert(draftNeeded !== undefined, "a draft_needed item was created");
    if (draftNeeded) {
      assert(
        draftNeeded.proposed_record === undefined,
        "draft_needed item omits proposed_record when no API key",
      );
    }
    assert(!called, "Anthropic SDK was never invoked");
  } finally {
    await rm(root, { recursive: true, force: true });
    if (prevKey !== undefined) process.env.ANTHROPIC_API_KEY = prevKey;
    restoreMock();
  }
}

// ── Test 7: feat + revert within window → revert suppressed ──────────────────

async function test7RevertWithinWindowSuppressed(): Promise<void> {
  console.error("\nTest 7: feat + revert within window → revert suppressed");
  installMock(async () => mockSuccessResponse());
  const prevKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "sk-mock";

  const root = await bootstrapRepo();
  try {
    await writeConfig(root, true);
    await commitNewAuthDir(root);
    await runPostCommitIn(root);
    const afterFeat = await readInboxItems(root);
    const featDraftCount = afterFeat.filter((i) => i.type === "draft_needed").length;

    const git = (args: string[]) =>
      execFileSync("git", args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    git(["revert", "--no-edit", "HEAD"]);
    await runPostCommitIn(root);
    const afterRevert = await readInboxItems(root);
    const revertDraftCount = afterRevert.filter((i) => i.type === "draft_needed").length;

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

// ── Test 8: feat 48h ago + revert now → revert drafts normally ──────────────

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
    await writeFile(join(root, "src", "feat48h", "b.ts"), "export const b = 2;\n", "utf8");
    gitOld(["add", "-A"]);
    gitOld(["commit", "-q", "-m", "feat: old module skeleton"]);
    await runPostCommitIn(root);
    const afterFeat = await readInboxItems(root);
    const featCount = afterFeat.filter((i) => i.type === "draft_needed").length;
    assert(featCount >= 1, `feat commit (48h ago) drafted >=1 inbox item (got ${featCount})`);

    execFileSync("git", ["revert", "--no-edit", "HEAD"], {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
    });
    await runPostCommitIn(root);
    const afterRevert = await readInboxItems(root);
    const revertNew = afterRevert.filter((i) => i.type === "draft_needed").length - featCount;
    assert(
      revertNew >= 1,
      `revert (outside window) drafted >=1 item (added ${revertNew})`,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = prevKey;
    restoreMock();
  }
}

// ── Test 9: hook-drafted inbox item carries scope fields ────────────────────

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

// ── Runner ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  try {
    execFileSync("git", ["--version"], { stdio: ["ignore", "pipe", "pipe"] });
  } catch {
    console.error("git not available — skipping hook integration tests");
    process.exit(0);
  }
  await test5WithDraft();
  await test6WithoutDraft();
  await test7RevertWithinWindowSuppressed();
  await test8RevertOutsideWindowDrafts();
  await test9ScopePopulated();
  console.error(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(`FATAL: ${err instanceof Error ? err.stack : String(err)}`);
  process.exit(1);
});
