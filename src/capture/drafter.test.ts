// context-ledger — drafter unit tests
// Standalone script: exit 0 on pass, 1 on fail.
// Mocks the Anthropic SDK by patching Messages.prototype.create.

import Anthropic from "@anthropic-ai/sdk";
import { synthesizeDraft } from "./drafter.js";
import type { ProposedDecision } from "./drafter.js";

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

interface MockCall {
  args: unknown[];
}
const calls: MockCall[] = [];

function installMock(fn: CreateFn): void {
  calls.length = 0;
  MessagesCtor.prototype.create = async function (...args: unknown[]) {
    calls.push({ args });
    return fn(...args);
  };
}

function restoreMock(): void {
  MessagesCtor.prototype.create = originalCreate;
}

function makeGoodDraft(): ProposedDecision {
  return {
    summary: "Switch password hashing from bcrypt to scrypt",
    decision: "Use scrypt via node:crypto for all new password hashing.",
    rationale:
      "scrypt is built in and avoids a native dependency. Bcrypt's Node bindings were flaky on alpine base images.",
    alternatives_considered: [
      {
        approach: "Keep bcrypt",
        why_rejected: "Native build failures on alpine in CI.",
        failure_conditions: null,
      },
    ],
    decision_kind: "auth-pattern",
    tags: ["auth", "crypto", "password"],
    durability: "precedent",
  };
}

function makeResponse(draft: ProposedDecision): unknown {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-haiku-4-5-20251001",
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
    content: [
      {
        type: "tool_use",
        id: "tool_test",
        name: "propose_decision",
        input: draft,
      },
    ],
  };
}

// ── Test 1: no API key ───────────────────────────────────────────────────────

async function test1NoApiKey(): Promise<void> {
  console.error("\nTest 1: null apiKey short-circuits without a network call");
  let called = false;
  installMock(async () => {
    called = true;
    return makeResponse(makeGoodDraft());
  });

  const result = await synthesizeDraft({
    commitSha: "abc123",
    commitMessage: "feat: test",
    changeCategory: "feature-local",
    changedFiles: ["src/foo.ts"],
    diff: "diff",
    existingPrecedents: [],
    config: { apiKey: null },
  });

  assert(result === null, "returns null with null apiKey");
  assert(!called, "SDK messages.create was not invoked");

  restoreMock();
}

// ── Test 2: successful response returns a populated ProposedDecision ─────────

async function test2SuccessfulResponse(): Promise<void> {
  console.error("\nTest 2: mocked successful tool_use → populated ProposedDecision");
  const draft = makeGoodDraft();
  installMock(async () => makeResponse(draft));

  const result = await synthesizeDraft({
    commitSha: "sha",
    commitMessage: "feat: scrypt",
    changeCategory: "module-replacement",
    changedFiles: ["src/auth/hash.ts"],
    diff: "diff contents",
    existingPrecedents: [{ summary: "old", decision: "use bcrypt" }],
    config: { apiKey: "sk-test" },
  });

  assert(result !== null, "returns a non-null draft");
  if (result) {
    assert(result.summary === draft.summary, "summary preserved");
    assert(result.decision === draft.decision, "decision preserved");
    assert(result.rationale === draft.rationale, "rationale preserved");
    assert(result.durability === "precedent", "durability preserved");
    assert(result.tags.length === 3, "tags preserved");
    assert(result.alternatives_considered.length === 1, "alternatives preserved");
  }
  assert(calls.length === 1, "SDK invoked exactly once");

  restoreMock();
}

// ── Test 3: timeout / error path ─────────────────────────────────────────────

async function test3TimeoutReturnsNull(): Promise<void> {
  console.error("\nTest 3: SDK throws → returns null, logs, does not throw");
  installMock(async () => {
    const err = new Error("Request timed out");
    err.name = "APIConnectionTimeoutError";
    throw err;
  });

  const originalConsoleError = console.error;
  const logs: string[] = [];
  console.error = (msg: unknown) => {
    logs.push(String(msg));
  };

  let threw = false;
  let result: ProposedDecision | null = {} as ProposedDecision;
  try {
    result = await synthesizeDraft({
      commitSha: "sha",
      commitMessage: "msg",
      changeCategory: "config-change",
      changedFiles: ["tsconfig.json"],
      diff: "d",
      existingPrecedents: [],
      config: { apiKey: "sk-test" },
    });
  } catch {
    threw = true;
  }

  console.error = originalConsoleError;

  assert(!threw, "synthesizeDraft did not throw");
  assert(result === null, "returns null on error");
  assert(
    logs.some((l) => l.includes("[context-ledger:drafter]") && l.includes("Request timed out")),
    "logs error to stderr with drafter prefix",
  );

  restoreMock();
}

// ── Test 4: diff truncation ──────────────────────────────────────────────────

async function test4DiffTruncation(): Promise<void> {
  console.error("\nTest 4: diff exceeding maxDiffChars is truncated with marker");
  let sentUserMessage = "";
  installMock(async (body: unknown) => {
    // body is the request params object; extract the user message text
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const messages = (body as any).messages as Array<{ role: string; content: unknown }>;
    const user = messages.find((m) => m.role === "user");
    if (user && typeof user.content === "string") {
      sentUserMessage = user.content;
    }
    return makeResponse(makeGoodDraft());
  });

  const bigDiff = "x".repeat(20000);

  await synthesizeDraft({
    commitSha: "sha",
    commitMessage: "msg",
    changeCategory: "new-directory",
    changedFiles: ["src/new/foo.ts"],
    diff: bigDiff,
    existingPrecedents: [],
    config: { apiKey: "sk-test", maxDiffChars: 500 },
  });

  assert(sentUserMessage.includes("...[truncated]"), "truncation marker appended");
  // Longest run of x's should be exactly maxDiffChars (500), not 20000
  const longestXRun = (sentUserMessage.match(/x+/g) ?? []).reduce(
    (max, r) => (r.length > max ? r.length : max),
    0,
  );
  assert(longestXRun === 500, `longest x-run equals maxDiffChars (got ${longestXRun})`);
  assert(!sentUserMessage.includes("x".repeat(501)), "no untruncated diff leaked through");

  restoreMock();
}

// ── Runner ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  await test1NoApiKey();
  await test2SuccessfulResponse();
  await test3TimeoutReturnsNull();
  await test4DiffTruncation();
  console.error(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(`FATAL: ${err instanceof Error ? err.stack : String(err)}`);
  process.exit(1);
});
