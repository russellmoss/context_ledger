// context-ledger — integration smoke tests
// Standalone script: exit 0 if all pass, exit 1 if any fail.

import { mkdtemp, rm, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DecisionRecord,
  TransitionEvent,
  generateDecisionId,
  generateTransitionId,
  RETRIEVAL_WEIGHTS,
} from "./events.js";
import { appendToLedger, readLedger, ledgerPath } from "./storage.js";
import { foldEvents, LedgerIntegrityError } from "./fold.js";

// ── Test Harness ──────────────────────────────────────────────────────────────

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

// ── Helper: make a DecisionRecord ─────────────────────────────────────────────

function makeDecision(overrides: Partial<DecisionRecord> & { id: string; evidence_type: DecisionRecord["evidence_type"]; durability: DecisionRecord["durability"] }): DecisionRecord {
  return {
    type: "decision",
    created: new Date().toISOString(),
    source: "manual",
    verification_status: "confirmed",
    commit_sha: null,
    summary: "Test decision",
    decision: "Test",
    alternatives_considered: [],
    rationale: "Test rationale",
    revisit_conditions: "None",
    review_after: null,
    scope: { type: "domain", id: "test" },
    affected_files: [],
    scope_aliases: [],
    decision_kind: "test",
    tags: [],
    ...overrides,
  };
}

// ── Helper: make a TransitionEvent ────────────────────────────────────────────

function makeTransition(overrides: Partial<TransitionEvent> & { target_id: string; action: TransitionEvent["action"] }): TransitionEvent {
  return {
    type: "transition",
    id: generateTransitionId(),
    created: new Date().toISOString(),
    replaced_by: null,
    reason: "Test reason",
    pain_points: null,
    source_feature_id: null,
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

async function test1_fullLifecycle(tmpDir: string): Promise<void> {
  console.error("\nTest 1: Full lifecycle (write → read → fold)");

  const d1 = makeDecision({ id: generateDecisionId(), evidence_type: "explicit_manual", durability: "precedent" });
  const d2 = makeDecision({ id: generateDecisionId(), evidence_type: "confirmed_draft", durability: "feature-local" });
  const d3 = makeDecision({
    id: generateDecisionId(),
    evidence_type: "workflow_writeback",
    durability: "temporary-workaround",
    review_after: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
  });

  // Write decisions
  await appendToLedger(d1, tmpDir);
  await appendToLedger(d2, tmpDir);
  await appendToLedger(d3, tmpDir);

  // Supersede d1 with d2
  await appendToLedger(makeTransition({ target_id: d1.id, action: "supersede", replaced_by: d2.id }), tmpDir);

  // Abandon d3
  await appendToLedger(makeTransition({ target_id: d3.id, action: "abandon", pain_points: ["workaround caused test flakes"] }), tmpDir);

  // Reinforce d2
  await appendToLedger(makeTransition({ target_id: d2.id, action: "reinforce", source_feature_id: "test-feature" }), tmpDir);

  // Reopen d3
  await appendToLedger(makeTransition({ target_id: d3.id, action: "reopen" }), tmpDir);

  // Illegal: supersede d1 again (already superseded)
  await appendToLedger(makeTransition({ target_id: d1.id, action: "supersede", replaced_by: d2.id }), tmpDir);

  // Cycle attempt: supersede d2 with d1 (d1 was superseded by d2)
  await appendToLedger(makeTransition({ target_id: d2.id, action: "supersede", replaced_by: d1.id }), tmpDir);

  const events = await readLedger(tmpDir);
  const state = foldEvents(events);

  const fd1 = state.decisions.get(d1.id)!;
  const fd2 = state.decisions.get(d2.id)!;
  const fd3 = state.decisions.get(d3.id)!;

  assert(fd1.state === "superseded", "d1 is superseded");
  assert(fd1.replaced_by === d2.id, "d1 replaced_by d2");
  assert(fd2.state === "active", "d2 is active");
  assert(fd2.reinforcement_count === 1, "d2 reinforcement_count is 1");
  assert(fd2.effective_rank_score > RETRIEVAL_WEIGHTS["confirmed_draft"], "d2 rank score increased by reinforce");
  assert(fd3.state === "active", "d3 is active (reopened from abandoned)");
  // The re-supersede of d1 is an idempotent no-op (same target+action+reason+replaced_by).
  // The cycle attempt (supersede d2 with d1) generates 1 warning.
  assert(state.warnings.length >= 1, `warnings array has >= 1 entry (got ${state.warnings.length})`);
  assert(state.warnings.some(w => w.includes("cycle") || w.includes("Cycle")), "cycle attempt produced a warning");
}

async function test2_featureLocalAutoExpiry(tmpDir: string): Promise<void> {
  console.error("\nTest 2: Feature-local auto-expiry");

  const sixtyOneDaysAgo = new Date(Date.now() - 61 * 24 * 60 * 60 * 1000).toISOString();
  const d = makeDecision({
    id: generateDecisionId(),
    evidence_type: "confirmed_draft",
    durability: "feature-local",
    created: sixtyOneDaysAgo,
  });

  await appendToLedger(d, tmpDir);
  const events = await readLedger(tmpDir);
  const state = foldEvents(events, { now: Date.now() });

  assert(state.decisions.get(d.id)!.state === "expired", "feature-local decision expired after 61 days");
}

async function test3_autoExpiryClockReset(tmpDir: string): Promise<void> {
  console.error("\nTest 3: Auto-expiry clock reset on reopen");

  const sixtyOneDaysAgo = new Date(Date.now() - 61 * 24 * 60 * 60 * 1000).toISOString();
  const d = makeDecision({
    id: generateDecisionId(),
    evidence_type: "confirmed_draft",
    durability: "feature-local",
    created: sixtyOneDaysAgo,
  });

  await appendToLedger(d, tmpDir);
  // Expire, then reopen with today's date
  await appendToLedger(makeTransition({ target_id: d.id, action: "expire" }), tmpDir);
  await appendToLedger(makeTransition({ target_id: d.id, action: "reopen", created: new Date().toISOString() }), tmpDir);

  const events = await readLedger(tmpDir);
  const state = foldEvents(events, { now: Date.now() });

  assert(state.decisions.get(d.id)!.state === "active", "feature-local decision active after reopen (clock reset)");
}

async function test4_strictModeThrows(tmpDir: string): Promise<void> {
  console.error("\nTest 4: Strict mode throws on corruption");

  const d = makeDecision({ id: generateDecisionId(), evidence_type: "explicit_manual", durability: "precedent" });
  await appendToLedger(d, tmpDir);

  // Append malformed line directly
  await appendFile(ledgerPath(tmpDir), "not valid json\n", "utf8");

  // readLedger should skip the bad line
  const events = await readLedger(tmpDir);
  assert(events.length === 1, "readLedger skipped malformed line");

  // Add a transition targeting non-existent decision
  const badTransition = makeTransition({ target_id: "d_nonexistent_0000", action: "abandon" });
  events.push(badTransition);

  let threw = false;
  try {
    foldEvents(events, { strict: true });
  } catch (err) {
    if (err instanceof LedgerIntegrityError) threw = true;
  }
  assert(threw, "strict mode threw LedgerIntegrityError on non-existent target");
}

async function test5_lenientModeCollectsWarnings(tmpDir: string): Promise<void> {
  console.error("\nTest 5: Lenient mode collects warnings");

  const d = makeDecision({ id: generateDecisionId(), evidence_type: "explicit_manual", durability: "precedent" });

  const events = [
    d,
    makeTransition({ target_id: "d_nonexistent_0000", action: "abandon" }),
  ];

  const state = foldEvents(events, { strict: false });
  assert(state.warnings.length > 0, `lenient mode collected ${state.warnings.length} warning(s)`);
}

// ── Runner ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.error("context-ledger integration tests\n================================");

  // Each test gets its own temp directory
  const dirs: string[] = [];

  try {
    for (const testFn of [test1_fullLifecycle, test2_featureLocalAutoExpiry, test3_autoExpiryClockReset, test4_strictModeThrows, test5_lenientModeCollectsWarnings]) {
      const dir = await mkdtemp(join(tmpdir(), "cl-test-"));
      dirs.push(dir);
      await testFn(dir);
    }
  } finally {
    for (const dir of dirs) {
      await rm(dir, { recursive: true, force: true });
    }
  }

  console.error(`\n================================`);
  console.error(`Results: ${passed} passed, ${failed} failed`);

  if (failed > 0) process.exit(1);
}

main();
