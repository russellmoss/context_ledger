// context-ledger — retrieval integration smoke tests
// Standalone script: exit 0 if all pass, exit 1 if any fail.

import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DecisionRecord, TransitionEvent } from "../ledger/index.js";
import { generateDecisionId, generateTransitionId, appendToLedger } from "../ledger/index.js";
import { loadConfig } from "../config.js";
import { queryDecisions, searchDecisions } from "./query.js";

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

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeDecision(
  overrides: Partial<DecisionRecord> & { id: string; evidence_type: DecisionRecord["evidence_type"]; durability: DecisionRecord["durability"] },
): DecisionRecord {
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

function makeTransition(
  overrides: Partial<TransitionEvent> & { target_id: string; action: TransitionEvent["action"] },
): TransitionEvent {
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

async function writeConfig(tmpDir: string, config: Record<string, unknown>): Promise<void> {
  const dir = join(tmpDir, ".context-ledger");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "config.json"), JSON.stringify(config), "utf8");
}

// ── Tests ────────────────────────────────────────────────────────────────────

async function test1_scopeFromConfigMapping(tmpDir: string): Promise<void> {
  console.error("\nTest 1: Scope derivation from file path with config mapping");

  await writeConfig(tmpDir, {
    capture: {
      scope_mappings: { "src/billing/": { type: "domain", id: "billing" } },
    },
  });

  const d = makeDecision({
    id: generateDecisionId(),
    evidence_type: "explicit_manual",
    durability: "precedent",
    scope: { type: "domain", id: "billing" },
    affected_files: ["src/billing/handler.ts"],
  });
  await appendToLedger(d, tmpDir);

  const pack = await queryDecisions({ file_path: "src/billing/handler.ts" }, tmpDir);
  assert(pack.derived_scope?.source === "config_mapping", "derived_scope.source === config_mapping");
  assert(pack.derived_scope?.id === "billing", "derived_scope.id === billing");
  assert(pack.active_precedents.length === 1, "active_precedents.length === 1");
}

async function test2_directoryFallback(tmpDir: string): Promise<void> {
  console.error("\nTest 2: Directory fallback when no config mapping");

  const d = makeDecision({
    id: generateDecisionId(),
    evidence_type: "explicit_manual",
    durability: "precedent",
    scope: { type: "directory", id: "retrieval" },
    affected_files: ["src/retrieval/scope.ts"],
  });
  await appendToLedger(d, tmpDir);

  const pack = await queryDecisions({ file_path: "src/retrieval/scope.ts" }, tmpDir);
  assert(pack.derived_scope?.source === "directory_fallback", "derived_scope.source === directory_fallback");
  assert(pack.derived_scope?.id === "retrieval", "derived_scope.id === retrieval");
}

async function test3_featureHintMapping(tmpDir: string): Promise<void> {
  console.error("\nTest 3: Feature hint mapping");

  await writeConfig(tmpDir, {
    retrieval: {
      feature_hint_mappings: { billing: ["billing-domain"] },
    },
  });

  const d = makeDecision({
    id: generateDecisionId(),
    evidence_type: "explicit_manual",
    durability: "precedent",
    scope: { type: "domain", id: "billing-domain" },
    summary: "Billing domain decision",
  });
  await appendToLedger(d, tmpDir);

  const pack = await queryDecisions({ query: "how does billing work" }, tmpDir);
  assert(pack.derived_scope?.source === "feature_hint", "derived_scope.source === feature_hint");
  assert(pack.active_precedents.length >= 1, "active_precedents.length >= 1");
}

async function test4_tokenBudgetTrimming(tmpDir: string): Promise<void> {
  console.error("\nTest 4: Token budgeting trims correctly");

  await writeConfig(tmpDir, {
    retrieval: { token_budget: 500 },
  });

  // Write many decisions to exceed the tiny budget
  const ids: string[] = [];
  for (let i = 0; i < 20; i++) {
    const id = generateDecisionId();
    ids.push(id);
    const d = makeDecision({
      id,
      evidence_type: "explicit_manual",
      durability: "precedent",
      scope: { type: "domain", id: "test" },
      summary: `Decision number ${i} with a reasonably long summary to inflate token count for the test`,
      decision: `We decided to do thing ${i} because of various complex reasons that require explanation`,
      rationale: `The rationale for decision ${i} involves multiple considerations including performance, maintainability, and developer experience`,
    });
    await appendToLedger(d, tmpDir);
  }

  const pack = await queryDecisions({ scope_type: "domain", scope_id: "test" }, tmpDir);
  assert(pack.truncated === true, "truncated === true");
  assert(pack.active_precedents.length < 20, `active_precedents trimmed (got ${pack.active_precedents.length})`);
}

async function test5_searchDecisionsLexical(tmpDir: string): Promise<void> {
  console.error("\nTest 5: search_decisions lexical match");

  const d1 = makeDecision({
    id: generateDecisionId(),
    evidence_type: "explicit_manual",
    durability: "precedent",
    summary: "We chose the fold order for event processing",
    decision: "Events are folded in append order",
  });
  const d2 = makeDecision({
    id: generateDecisionId(),
    evidence_type: "explicit_manual",
    durability: "precedent",
    summary: "Billing invoice format",
    decision: "Use PDF for invoices",
  });
  await appendToLedger(d1, tmpDir);
  await appendToLedger(d2, tmpDir);

  const results = await searchDecisions("fold order", tmpDir);
  assert(results.length >= 1, "found at least 1 result");
  assert(results[0].record.id === d1.id, "matched the correct decision");
}

async function test6_abandonedPainPoints(tmpDir: string): Promise<void> {
  console.error("\nTest 6: Abandoned approaches include pain_points");

  const d = makeDecision({
    id: generateDecisionId(),
    evidence_type: "explicit_manual",
    durability: "precedent",
    scope: { type: "domain", id: "auth" },
  });
  await appendToLedger(d, tmpDir);
  await appendToLedger(
    makeTransition({
      target_id: d.id,
      action: "abandon",
      pain_points: ["caused memory leaks", "broke on Windows"],
    }),
    tmpDir,
  );

  const pack = await queryDecisions({ scope_type: "domain", scope_id: "auth" }, tmpDir);
  assert(pack.abandoned_approaches.length === 1, "abandoned_approaches.length === 1");
  assert(
    pack.abandoned_approaches[0].pain_points.includes("caused memory leaks"),
    "pain_points includes expected value",
  );
}

async function test7_featureLocalExclusion(tmpDir: string): Promise<void> {
  console.error("\nTest 7: Feature-local exclusion");

  const d = makeDecision({
    id: generateDecisionId(),
    evidence_type: "explicit_manual",
    durability: "feature-local",
    scope: { type: "domain", id: "test" },
    affected_files: ["src/feature/specific.ts"],
  });
  await appendToLedger(d, tmpDir);

  // Query without matching file_path — should be excluded
  const pack = await queryDecisions({ scope_type: "domain", scope_id: "test" }, tmpDir);
  assert(pack.active_precedents.length === 0, "feature-local excluded without file_path match");
}

async function test8_recencyFallback(tmpDir: string): Promise<void> {
  console.error("\nTest 8: Recency fallback when no scope derived");

  const d1 = makeDecision({
    id: generateDecisionId(),
    evidence_type: "explicit_manual",
    durability: "precedent",
    scope: { type: "domain", id: "alpha" },
    created: new Date(Date.now() - 2000).toISOString(),
  });
  const d2 = makeDecision({
    id: generateDecisionId(),
    evidence_type: "explicit_manual",
    durability: "precedent",
    scope: { type: "domain", id: "beta" },
    created: new Date(Date.now() - 1000).toISOString(),
  });
  await appendToLedger(d1, tmpDir);
  await appendToLedger(d2, tmpDir);

  // No config, no scope_mappings, unrelated query — should trigger recency fallback
  const pack = await queryDecisions({ query: "something completely unrelated" }, tmpDir);
  assert(pack.derived_scope === null, "derived_scope === null");
  assert(pack.active_precedents.length === 2, "includes all active precedents");
  assert(
    pack.active_precedents.every((p) => p.match_reason === "broad_fallback"),
    "all marked broad_fallback",
  );
}

async function test9_explicitScopeParams(tmpDir: string): Promise<void> {
  console.error("\nTest 9: Explicit scope parameters");

  const d = makeDecision({
    id: generateDecisionId(),
    evidence_type: "explicit_manual",
    durability: "precedent",
    scope: { type: "domain", id: "auth" },
  });
  await appendToLedger(d, tmpDir);

  const pack = await queryDecisions({ scope_type: "domain", scope_id: "auth" }, tmpDir);
  assert(pack.derived_scope?.source === "explicit", "derived_scope.source === explicit");
  assert(pack.active_precedents.length === 1, "active_precedents.length === 1");
}

async function test10_includeUnreviewed(tmpDir: string): Promise<void> {
  console.error("\nTest 10: include_unreviewed default excludes unreviewed");

  const d = makeDecision({
    id: generateDecisionId(),
    evidence_type: "commit_inferred",
    durability: "precedent",
    verification_status: "unreviewed",
    scope: { type: "domain", id: "test" },
  });
  await appendToLedger(d, tmpDir);

  // Default: exclude unreviewed
  const pack1 = await queryDecisions({ scope_type: "domain", scope_id: "test" }, tmpDir);
  assert(pack1.active_precedents.length === 0, "unreviewed excluded by default");

  // Explicit include
  const pack2 = await queryDecisions(
    { scope_type: "domain", scope_id: "test", include_unreviewed: true },
    tmpDir,
  );
  assert(pack2.active_precedents.length === 1, "unreviewed included when explicitly requested");
}

async function test11_reviewOverdue(tmpDir: string): Promise<void> {
  console.error("\nTest 11: review_overdue flag");

  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const d = makeDecision({
    id: generateDecisionId(),
    evidence_type: "explicit_manual",
    durability: "temporary-workaround",
    review_after: yesterday,
    scope: { type: "domain", id: "test" },
  });
  await appendToLedger(d, tmpDir);

  const pack = await queryDecisions({ scope_type: "domain", scope_id: "test" }, tmpDir);
  assert(pack.active_precedents.length === 1, "decision included");
  assert(pack.active_precedents[0].review_overdue === true, "review_overdue === true");
}

// ── Runner ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.error("context-ledger retrieval smoke tests\n====================================");

  const tests = [
    test1_scopeFromConfigMapping,
    test2_directoryFallback,
    test3_featureHintMapping,
    test4_tokenBudgetTrimming,
    test5_searchDecisionsLexical,
    test6_abandonedPainPoints,
    test7_featureLocalExclusion,
    test8_recencyFallback,
    test9_explicitScopeParams,
    test10_includeUnreviewed,
    test11_reviewOverdue,
  ];

  const dirs: string[] = [];

  try {
    for (const testFn of tests) {
      const dir = await mkdtemp(join(tmpdir(), "cl-ret-"));
      dirs.push(dir);
      await testFn(dir);
    }
  } finally {
    for (const dir of dirs) {
      await rm(dir, { recursive: true, force: true });
    }
  }

  console.error(`\n====================================`);
  console.error(`Results: ${passed} passed, ${failed} failed`);

  if (failed > 0) process.exit(1);
}

main();
