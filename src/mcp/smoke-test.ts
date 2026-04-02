// context-ledger — MCP write tools smoke tests
// Standalone script: exit 0 if all pass, exit 1 if any fail.
// Tests tool handler logic directly (not via MCP protocol).

import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DecisionRecord, InboxItem } from "../ledger/index.js";
import {
  generateDecisionId,
  appendToLedger,
  readLedger,
  readInbox,
  foldLedger,
} from "../ledger/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerReadTools, registerWriteTools } from "./index.js";

// ── Test Harness ─────────────────────────────────────────────────────────────

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

// ── Helper: call a registered tool handler via the McpServer ─────────────────

// The MCP SDK doesn't expose a direct way to call tool handlers, so we
// construct our own handler map by intercepting server.tool() calls.

type ToolHandler = (args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;

const toolHandlers = new Map<string, ToolHandler>();

function createInstrumentedServer(projectRoot: string): void {
  const server = new McpServer({ name: "test", version: "0.0.0" });

  // Monkey-patch server.tool to capture handlers
  const originalTool = server.tool.bind(server);
  (server as any).tool = (name: string, desc: string, schema: any, annotations: any, handler: any) => {
    toolHandlers.set(name, handler as ToolHandler);
    return originalTool(name, desc, schema, annotations, handler);
  };

  registerReadTools(server, projectRoot);
  registerWriteTools(server, projectRoot);
}

async function callTool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const handler = toolHandlers.get(name);
  if (!handler) throw new Error(`Tool ${name} not registered`);
  const result = await handler(args);
  return JSON.parse(result.content[0].text);
}

// ── Helper: create a decision record ─────────────────────────────────────────

function makeDecision(
  overrides: Partial<DecisionRecord> & { id: string },
): DecisionRecord {
  return {
    type: "decision",
    created: new Date().toISOString(),
    source: "manual",
    evidence_type: "explicit_manual",
    verification_status: "confirmed",
    commit_sha: null,
    summary: "Test decision",
    decision: "Use X for Y",
    alternatives_considered: [],
    rationale: "Because reasons",
    revisit_conditions: "None",
    review_after: null,
    scope: { type: "domain", id: "test" },
    affected_files: [],
    scope_aliases: [],
    decision_kind: "architecture",
    tags: [],
    durability: "precedent",
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

async function runTests(): Promise<void> {
  console.error("context-ledger MCP smoke tests");
  console.error("==============================");
  console.error("");

  // Test 1: propose_decision creates inbox item
  {
    console.error("Test 1: propose_decision creates inbox item");
    const tmpDir = await mkdtemp(join(tmpdir(), "cl-mcp-"));
    await mkdir(join(tmpDir, ".context-ledger"), { recursive: true });
    toolHandlers.clear();
    createInstrumentedServer(tmpDir);

    const result = await callTool("propose_decision", {
      client_operation_id: "test-20260401-aaa1",
      summary: "Use PostgreSQL",
      decision: "We will use PostgreSQL as our primary database",
      rationale: "ACID compliance and ecosystem support",
      scope_type: "domain",
      scope_id: "database",
      durability: "precedent",
    });

    assert(result.status === "proposed", "status === proposed");
    assert(typeof result.inbox_id === "string", "inbox_id is string");

    const inbox = await readInbox(tmpDir) as Array<InboxItem & { client_operation_id?: string; proposed_record?: any }>;
    assert(inbox.length === 1, "inbox has 1 item");
    assert(inbox[0].status === "pending", "item status is pending");
    assert(inbox[0].client_operation_id === "test-20260401-aaa1", "client_operation_id stored");

    await rm(tmpDir, { recursive: true, force: true });
  }

  // Test 2: propose_decision idempotency
  {
    console.error("Test 2: propose_decision idempotency");
    const tmpDir = await mkdtemp(join(tmpdir(), "cl-mcp-"));
    await mkdir(join(tmpDir, ".context-ledger"), { recursive: true });
    toolHandlers.clear();
    createInstrumentedServer(tmpDir);

    const args = {
      client_operation_id: "test-20260401-bbb2",
      summary: "Use Redis",
      decision: "Use Redis for caching",
      rationale: "Performance",
      scope_type: "domain",
      scope_id: "cache",
      durability: "precedent" as const,
    };

    await callTool("propose_decision", args);
    await callTool("propose_decision", args);

    const inbox = await readInbox(tmpDir);
    assert(inbox.length === 1, "only 1 inbox item after duplicate propose");

    await rm(tmpDir, { recursive: true, force: true });
  }

  // Test 3: confirm_pending writes to ledger
  {
    console.error("Test 3: confirm_pending writes to ledger");
    const tmpDir = await mkdtemp(join(tmpdir(), "cl-mcp-"));
    await mkdir(join(tmpDir, ".context-ledger"), { recursive: true });
    toolHandlers.clear();
    createInstrumentedServer(tmpDir);

    const proposeResult = await callTool("propose_decision", {
      client_operation_id: "test-20260401-ccc3",
      summary: "Use TypeScript strict",
      decision: "Enable strict mode",
      rationale: "Type safety",
      scope_type: "concern",
      scope_id: "typescript",
      durability: "precedent",
    });

    const confirmResult = await callTool("confirm_pending", {
      inbox_id: proposeResult.inbox_id,
      client_operation_id: "test-20260401-ccc4",
    });

    assert(confirmResult.status === "confirmed", "status === confirmed");
    assert(typeof confirmResult.decision_id === "string", "decision_id returned");

    const ledger = await readLedger(tmpDir);
    assert(ledger.length === 1, "ledger has 1 record");
    assert(ledger[0].type === "decision", "record type is decision");

    const inbox = await readInbox(tmpDir);
    assert(inbox[0].status === "confirmed", "inbox item status is confirmed");

    await rm(tmpDir, { recursive: true, force: true });
  }

  // Test 4: reject_pending dismisses inbox item
  {
    console.error("Test 4: reject_pending dismisses inbox item");
    const tmpDir = await mkdtemp(join(tmpdir(), "cl-mcp-"));
    await mkdir(join(tmpDir, ".context-ledger"), { recursive: true });
    toolHandlers.clear();
    createInstrumentedServer(tmpDir);

    const proposeResult = await callTool("propose_decision", {
      client_operation_id: "test-20260401-ddd5",
      summary: "Use MongoDB",
      decision: "Switch to MongoDB",
      rationale: "Flexibility",
      scope_type: "domain",
      scope_id: "database",
      durability: "feature-local",
    });

    const rejectResult = await callTool("reject_pending", {
      inbox_id: proposeResult.inbox_id,
      client_operation_id: "test-20260401-ddd6",
      reason: "Not suitable for our use case",
    });

    assert(rejectResult.status === "rejected", "status === rejected");

    const inbox = await readInbox(tmpDir);
    assert(inbox[0].status === "dismissed", "inbox item status is dismissed");

    await rm(tmpDir, { recursive: true, force: true });
  }

  // Test 5: supersede_decision validates lifecycle
  {
    console.error("Test 5: supersede_decision validates lifecycle");
    const tmpDir = await mkdtemp(join(tmpdir(), "cl-mcp-"));
    await mkdir(join(tmpDir, ".context-ledger"), { recursive: true });
    toolHandlers.clear();
    createInstrumentedServer(tmpDir);

    const d1 = makeDecision({ id: generateDecisionId(), summary: "Original approach" });
    const d2 = makeDecision({ id: generateDecisionId(), summary: "New approach" });
    await appendToLedger(d1, tmpDir);
    await appendToLedger(d2, tmpDir);

    const supersedeResult = await callTool("supersede_decision", {
      target_id: d1.id,
      replaced_by: d2.id,
      client_operation_id: "test-20260401-eee7",
      reason: "Better approach found",
      pain_points: ["Too complex"],
    });

    assert(supersedeResult.status === "superseded", "status === superseded");

    const state = await foldLedger(tmpDir);
    const folded1 = state.decisions.get(d1.id);
    assert(folded1?.state === "superseded", "d1 is superseded");

    // Try to supersede already-superseded decision
    const failResult = await callTool("supersede_decision", {
      target_id: d1.id,
      replaced_by: d2.id,
      client_operation_id: "test-20260401-eee8",
      reason: "Trying again",
    });

    assert(failResult.status === "error", "superseding superseded decision returns error");

    await rm(tmpDir, { recursive: true, force: true });
  }

  // Test 6: supersede_decision idempotency
  {
    console.error("Test 6: supersede_decision idempotency");
    const tmpDir = await mkdtemp(join(tmpdir(), "cl-mcp-"));
    await mkdir(join(tmpDir, ".context-ledger"), { recursive: true });
    toolHandlers.clear();
    createInstrumentedServer(tmpDir);

    const d1 = makeDecision({ id: generateDecisionId(), summary: "Old" });
    const d2 = makeDecision({ id: generateDecisionId(), summary: "New" });
    await appendToLedger(d1, tmpDir);
    await appendToLedger(d2, tmpDir);

    const args = {
      target_id: d1.id,
      replaced_by: d2.id,
      client_operation_id: "test-20260401-fff9",
      reason: "Better",
    };

    await callTool("supersede_decision", args);
    await callTool("supersede_decision", args);

    const ledger = await readLedger(tmpDir);
    const transitions = ledger.filter((e) => e.type === "transition");
    assert(transitions.length === 1, "only 1 transition event after duplicate supersede");

    await rm(tmpDir, { recursive: true, force: true });
  }

  // Test 7: record_writeback creates new record
  {
    console.error("Test 7: record_writeback creates new record");
    const tmpDir = await mkdtemp(join(tmpdir(), "cl-mcp-"));
    await mkdir(join(tmpDir, ".context-ledger"), { recursive: true });
    toolHandlers.clear();
    createInstrumentedServer(tmpDir);

    const result = await callTool("record_writeback", {
      client_operation_id: "test-20260401-ggg0",
      source_feature_id: "feat-123",
      summary: "Use ESM modules",
      decision: "All packages use ESM",
      rationale: "Modern standard",
      scope_type: "concern",
      scope_id: "module-system",
      durability: "precedent",
    });

    assert(result.status === "created", "status === created");
    assert(typeof result.decision_id === "string", "decision_id returned");

    const ledger = await readLedger(tmpDir);
    assert(ledger.length === 1, "ledger has 1 record");
    assert((ledger[0] as DecisionRecord).source === "workflow-writeback", "source is workflow-writeback");

    await rm(tmpDir, { recursive: true, force: true });
  }

  // Test 8: record_writeback conflict detection with existing precedent (C1 fix)
  {
    console.error("Test 8: record_writeback conflict detection (C1 fix)");
    const tmpDir = await mkdtemp(join(tmpdir(), "cl-mcp-"));
    await mkdir(join(tmpDir, ".context-ledger"), { recursive: true });
    toolHandlers.clear();
    createInstrumentedServer(tmpDir);

    // Write existing active precedent in "auth" scope
    const existing = makeDecision({
      id: generateDecisionId(),
      summary: "Use JWT for auth",
      decision: "JWT tokens for authentication",
      scope: { type: "domain", id: "auth" },
      durability: "precedent",
    });
    await appendToLedger(existing, tmpDir);

    // Attempt writeback to same scope
    const result = await callTool("record_writeback", {
      client_operation_id: "test-20260401-hhh1",
      source_feature_id: "feat-456",
      summary: "Use session cookies",
      decision: "Switch to session cookies",
      rationale: "Simpler implementation",
      scope_type: "domain",
      scope_id: "auth",
      durability: "precedent",
    });

    assert(result.status === "conflict_detected", "status === conflict_detected");
    assert(result.existing_precedent != null, "existing_precedent populated");
    assert(typeof result.message === "string", "message provided");

    await rm(tmpDir, { recursive: true, force: true });
  }

  // Test 9: record_writeback creates new when no precedent in scope
  {
    console.error("Test 9: record_writeback creates new when no precedent in scope");
    const tmpDir = await mkdtemp(join(tmpdir(), "cl-mcp-"));
    await mkdir(join(tmpDir, ".context-ledger"), { recursive: true });
    toolHandlers.clear();
    createInstrumentedServer(tmpDir);

    // Write existing decision in DIFFERENT scope
    const existing = makeDecision({
      id: generateDecisionId(),
      scope: { type: "domain", id: "database" },
      durability: "precedent",
    });
    await appendToLedger(existing, tmpDir);

    const result = await callTool("record_writeback", {
      client_operation_id: "test-20260401-iii2",
      source_feature_id: "feat-789",
      summary: "Use REST API",
      decision: "REST over GraphQL",
      rationale: "Team familiarity",
      scope_type: "domain",
      scope_id: "api-layer",
      durability: "precedent",
    });

    assert(result.status === "created", "status === created (different scope)");

    const ledger = await readLedger(tmpDir);
    const writebacks = ledger.filter((e) => e.type === "decision" && (e as DecisionRecord).source === "workflow-writeback");
    assert(writebacks.length === 1, "new record created in different scope");

    await rm(tmpDir, { recursive: true, force: true });
  }

  // ── Summary ────────────────────────────────────────────────────────────────

  console.error("");
  console.error("==============================");
  console.error(`Results: ${passed} passed, ${failed} failed`);

  if (failed > 0) process.exit(1);
}

runTests().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
