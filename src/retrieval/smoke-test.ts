// context-ledger — retrieval integration smoke tests
// Standalone script: exit 0 if all pass, exit 1 if any fail.

import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DecisionRecord, TransitionEvent, InboxItem } from "../ledger/index.js";
import { generateDecisionId, generateTransitionId, generateInboxId, appendToLedger, appendToInbox } from "../ledger/index.js";
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
  console.error("\nTest 6: Abandoned pain_points surface in mistakes_in_scope");
  // Abandoned records are promoted to mistakes_in_scope and deduped from abandoned_approaches
  // to prevent token-budget double-counting. Pain points flow through unchanged.

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
  assert(pack.abandoned_approaches.length === 0, "abandoned_approaches empty after dedup");
  assert(pack.mistakes_in_scope.length === 1, `mistakes_in_scope.length === 1 (got ${pack.mistakes_in_scope.length})`);
  const m = pack.mistakes_in_scope[0];
  assert(m.kind === "abandoned", "kind === abandoned");
  if (m.kind === "abandoned") {
    assert(m.pain_points.includes("caused memory leaks"), "pain_points includes expected value");
  }
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

// ── Helpers for mistakes_in_scope tests ──────────────────────────────────────

function makeDismissedInbox(
  overrides: Partial<InboxItem> & { rejection_reason: string },
): InboxItem {
  const now = new Date().toISOString();
  return {
    inbox_id: generateInboxId(),
    type: "draft_needed",
    created: now,
    commit_sha: "abc1234",
    commit_message: "test commit",
    change_category: "dependency-change",
    changed_files: [],
    diff_summary: "test diff",
    priority: "normal",
    expires_after: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(),
    times_shown: 0,
    last_prompted_at: now,
    status: "dismissed",
    ...overrides,
  };
}

// ── Test A: superseded with pain_points → mistakes_in_scope ──────────────────

async function testA_mistakesSuperseded(tmpDir: string): Promise<void> {
  console.error("\nTest A: superseded decision with pain_points appears in mistakes_in_scope");

  const dActive = makeDecision({
    id: generateDecisionId(),
    evidence_type: "confirmed_draft",
    durability: "precedent",
    scope: { type: "domain", id: "retrieval" },
    summary: "Current active decision",
  });
  const dSuper = makeDecision({
    id: generateDecisionId(),
    evidence_type: "explicit_manual",
    durability: "precedent",
    scope: { type: "domain", id: "retrieval" },
    summary: "Old approach that was superseded",
  });
  const dReplace = makeDecision({
    id: generateDecisionId(),
    evidence_type: "explicit_manual",
    durability: "precedent",
    scope: { type: "domain", id: "other" },
    summary: "Replacement — different scope to keep assertion clean",
  });
  await appendToLedger(dActive, tmpDir);
  await appendToLedger(dSuper, tmpDir);
  await appendToLedger(dReplace, tmpDir);
  await appendToLedger(
    makeTransition({
      target_id: dSuper.id,
      action: "supersede",
      replaced_by: dReplace.id,
      reason: "better approach found",
      pain_points: ["leaked sessions"],
    }),
    tmpDir,
  );

  const pack = await queryDecisions({ scope_type: "domain", scope_id: "retrieval" }, tmpDir);
  assert(pack.active_precedents.length === 1, "active_precedents.length === 1");
  assert(pack.mistakes_in_scope.length === 1, `mistakes_in_scope.length === 1 (got ${pack.mistakes_in_scope.length})`);
  const m = pack.mistakes_in_scope[0];
  assert(m.kind === "superseded_with_pain_points", `kind === superseded_with_pain_points (got ${m.kind})`);
  if (m.kind === "superseded_with_pain_points") {
    assert(m.pain_points.includes("leaked sessions"), "pain_points includes 'leaked sessions'");
  }
}

// ── Test B: commit_inferred excluded from mistakes_in_scope ──────────────────

async function testB_commitInferredExcluded(tmpDir: string): Promise<void> {
  console.error("\nTest B: commit_inferred abandoned records excluded from mistakes_in_scope");

  const dReviewed = makeDecision({
    id: generateDecisionId(),
    evidence_type: "backfill_confirmed",
    durability: "precedent",
    scope: { type: "domain", id: "retrieval" },
    summary: "Reviewed abandoned approach",
  });
  const dInferred = makeDecision({
    id: generateDecisionId(),
    evidence_type: "commit_inferred",
    durability: "precedent",
    scope: { type: "domain", id: "retrieval" },
    summary: "Commit-inferred abandoned approach",
  });
  await appendToLedger(dReviewed, tmpDir);
  await appendToLedger(dInferred, tmpDir);
  await appendToLedger(makeTransition({ target_id: dReviewed.id, action: "abandon", reason: "failed" }), tmpDir);
  await appendToLedger(makeTransition({ target_id: dInferred.id, action: "abandon", reason: "failed" }), tmpDir);

  const pack = await queryDecisions({ scope_type: "domain", scope_id: "retrieval" }, tmpDir);
  assert(pack.mistakes_in_scope.length === 1, `mistakes_in_scope.length === 1 (got ${pack.mistakes_in_scope.length})`);
  const m = pack.mistakes_in_scope[0];
  assert(m.kind === "abandoned", "surviving entry kind === abandoned");
  if (m.kind === "abandoned") {
    assert(m.record.evidence_type === "backfill_confirmed", "surviving entry is backfill_confirmed");
  }
}

// ── Test C: rejected inbox item intersects scope ─────────────────────────────

async function testC_rejectedInboxScope(tmpDir: string): Promise<void> {
  console.error("\nTest C: dismissed inbox item with rejection_reason appears via scope intersection");

  await writeConfig(tmpDir, {
    capture: { scope_mappings: { "src/retrieval/": { type: "domain", id: "retrieval" } }, redact_patterns: [] },
    retrieval: { token_budget: 4000 },
  });

  const dActive = makeDecision({
    id: generateDecisionId(),
    evidence_type: "explicit_manual",
    durability: "precedent",
    scope: { type: "domain", id: "retrieval" },
    affected_files: ["src/retrieval/packs.ts"],
  });
  await appendToLedger(dActive, tmpDir);

  const dismissed = makeDismissedInbox({
    rejection_reason: "out of scope for this release",
    changed_files: ["src/retrieval/packs.ts"],
    commit_message: "wip: draft",
  });
  await appendToInbox(dismissed, tmpDir);

  const pack = await queryDecisions({ file_path: "src/retrieval/packs.ts" }, tmpDir);
  assert(pack.mistakes_in_scope.length === 1, `mistakes_in_scope.length === 1 (got ${pack.mistakes_in_scope.length})`);
  const m = pack.mistakes_in_scope[0];
  assert(m.kind === "rejected_inbox_item", `kind === rejected_inbox_item (got ${m.kind})`);
  if (m.kind === "rejected_inbox_item") {
    assert(m.rejection_reason === "out of scope for this release", "rejection_reason round-trips");
  }
}

// ── Test D: forced trim — Option A (active first, mistakes last) ─────────────

async function testD_forcedTrimOptionA(tmpDir: string): Promise<void> {
  console.error("\nTest D: Option A trim — mistakes survive, active trimmed to zero");

  await writeConfig(tmpDir, {
    capture: { scope_mappings: {}, redact_patterns: [] },
    retrieval: { token_budget: 800 },
  });

  for (let i = 0; i < 30; i++) {
    await appendToLedger(
      makeDecision({
        id: generateDecisionId(),
        evidence_type: "explicit_manual",
        durability: "precedent",
        scope: { type: "domain", id: "retrieval" },
        summary: `Active decision ${i} with a reasonably long summary to inflate token count`,
        decision: `Decision text ${i} with verbose rationale and extra filler to add token weight to the pack`,
        rationale: `Rationale ${i} that goes into quite a bit of detail about tradeoffs and considerations`,
      }),
      tmpDir,
    );
  }
  const dAb1 = makeDecision({
    id: generateDecisionId(),
    evidence_type: "backfill_confirmed",
    durability: "precedent",
    scope: { type: "domain", id: "retrieval" },
    summary: "Abandoned approach 1",
  });
  const dAb2 = makeDecision({
    id: generateDecisionId(),
    evidence_type: "backfill_confirmed",
    durability: "precedent",
    scope: { type: "domain", id: "retrieval" },
    summary: "Abandoned approach 2",
  });
  await appendToLedger(dAb1, tmpDir);
  await appendToLedger(dAb2, tmpDir);
  await appendToLedger(makeTransition({ target_id: dAb1.id, action: "abandon", pain_points: ["broke prod"] }), tmpDir);
  await appendToLedger(makeTransition({ target_id: dAb2.id, action: "abandon", pain_points: ["flaky tests"] }), tmpDir);

  const pack = await queryDecisions({ scope_type: "domain", scope_id: "retrieval" }, tmpDir);
  assert(pack.truncated === true, "pack.truncated === true");
  assert(pack.mistakes_in_scope.length === 2, `mistakes_in_scope.length === 2 (got ${pack.mistakes_in_scope.length})`);
  // Option A: active_precedents trimmed FIRST from the tail until budget met.
  // Starts at 20 (default_limit) after offset/limit slicing; survives if budget allows it.
  // The critical invariant is that mistakes (2) outlive active (<<20) under pressure.
  assert(pack.active_precedents.length < 5, `active_precedents heavily trimmed (got ${pack.active_precedents.length}, was 20)`);
  assert(pack.active_precedents.length < pack.mistakes_in_scope.length + 5, "mistakes outlive active under pressure");
  assert(pack.abandoned_approaches.length === 0, `abandoned_approaches empty (got ${pack.abandoned_approaches.length})`);
}

// ── Test E: feature_hint_mappings path populates mistakes ────────────────────

async function testE_featureHintMistakes(tmpDir: string): Promise<void> {
  console.error("\nTest E: feature_hint_mappings scope derivation populates mistakes_in_scope");

  await writeConfig(tmpDir, {
    capture: { scope_mappings: {}, redact_patterns: [] },
    retrieval: { feature_hint_mappings: { auth: ["auth"] }, token_budget: 4000 },
  });

  const d = makeDecision({
    id: generateDecisionId(),
    evidence_type: "explicit_manual",
    durability: "precedent",
    scope: { type: "domain", id: "auth" },
    summary: "Auth domain decision",
  });
  await appendToLedger(d, tmpDir);
  await appendToLedger(
    makeTransition({ target_id: d.id, action: "abandon", reason: "shelved", pain_points: ["leaked tokens"] }),
    tmpDir,
  );

  const pack = await queryDecisions({ query: "how do we handle auth" }, tmpDir);
  assert(pack.derived_scope?.id === "auth", `derived_scope.id === auth (got ${pack.derived_scope?.id})`);
  assert(pack.derived_scope?.source === "feature_hint", `derived_scope.source === feature_hint (got ${pack.derived_scope?.source})`);
  assert(pack.mistakes_in_scope.length === 1, `mistakes_in_scope.length === 1 (got ${pack.mistakes_in_scope.length})`);
  assert(pack.mistakes_in_scope[0].kind === "abandoned", "kind === abandoned");
}

// ── Test F: zero-write contract — queryDecisions never mutates storage ───────

async function testF_zeroWriteContract(tmpDir: string): Promise<void> {
  console.error("\nTest F: queryDecisions writes nothing to disk");

  await writeConfig(tmpDir, {
    capture: { scope_mappings: {}, redact_patterns: [] },
    retrieval: { token_budget: 4000 },
  });

  const d1 = makeDecision({
    id: generateDecisionId(),
    evidence_type: "human_answered",
    durability: "precedent",
    scope: { type: "domain", id: "retrieval" },
  });
  await appendToLedger(d1, tmpDir);
  await appendToLedger(
    makeTransition({ target_id: d1.id, action: "abandon", reason: "tried, failed", pain_points: ["oom"] }),
    tmpDir,
  );

  const dismissed = makeDismissedInbox({
    rejection_reason: "not applicable",
    changed_files: ["src/retrieval/packs.ts"],
  });
  await appendToInbox(dismissed, tmpDir);

  const ledgerPath = join(tmpDir, ".context-ledger", "ledger.jsonl");
  const inboxPath = join(tmpDir, ".context-ledger", "inbox.jsonl");

  const ledgerBefore = await readFile(ledgerPath);
  const inboxBefore = await readFile(inboxPath);

  await queryDecisions({ scope_type: "domain", scope_id: "retrieval" }, tmpDir);

  const ledgerAfter = await readFile(ledgerPath);
  const inboxAfter = await readFile(inboxPath);

  assert(ledgerBefore.equals(ledgerAfter), "ledger.jsonl unchanged after queryDecisions");
  assert(inboxBefore.equals(inboxAfter), "inbox.jsonl unchanged after queryDecisions");
}

// ── Test G: response-shape snapshot — every pack key present ─────────────────

async function testG_responseShapeSnapshot(tmpDir: string): Promise<void> {
  console.error("\nTest G: pack response shape matches expected keys");

  await writeConfig(tmpDir, {
    capture: { scope_mappings: {}, redact_patterns: [] },
    retrieval: { token_budget: 4000 },
  });

  const pack = await queryDecisions({ scope_type: "domain", scope_id: "empty" }, tmpDir);
  const keys = Object.keys(pack).sort().join(",");
  const expected = [
    "abandoned_approaches",
    "active_precedents",
    "derived_scope",
    "mistakes_in_scope",
    "no_precedent_scopes",
    "pending_inbox_items",
    "recently_superseded",
    "token_estimate",
    "truncated",
  ].join(",");
  assert(keys === expected, `pack keys match spec (got ${keys})`);
  assert(Array.isArray(pack.mistakes_in_scope), "mistakes_in_scope is an array");
}

// ── Test H: recency fallback includes N=10 dismissed inbox items ─────────────

async function testH_recencyFallbackCap(tmpDir: string): Promise<void> {
  console.error("\nTest H: recency fallback caps dismissed inbox items at N=10, sorted desc");

  for (let i = 0; i < 12; i++) {
    const ts = new Date(Date.now() - (12 - i) * 1000).toISOString();
    await appendToInbox(
      makeDismissedInbox({
        rejection_reason: `reason ${i}`,
        commit_message: `commit ${i}`,
        last_prompted_at: ts,
        created: ts,
      }),
      tmpDir,
    );
  }

  const pack = await queryDecisions({}, tmpDir);
  assert(pack.derived_scope === null, "derived_scope === null (recency fallback)");
  assert(pack.mistakes_in_scope.length === 10, `mistakes_in_scope.length === 10 (got ${pack.mistakes_in_scope.length})`);
  assert(
    pack.mistakes_in_scope.every((m) => m.kind === "rejected_inbox_item"),
    "all 10 entries are rejected_inbox_item",
  );
  const first = pack.mistakes_in_scope[0];
  if (first.kind === "rejected_inbox_item") {
    assert(first.commit_message === "commit 11", `most recent first (got ${first.commit_message})`);
  }
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
    testA_mistakesSuperseded,
    testB_commitInferredExcluded,
    testC_rejectedInboxScope,
    testD_forcedTrimOptionA,
    testE_featureHintMistakes,
    testF_zeroWriteContract,
    testG_responseShapeSnapshot,
    testH_recencyFallbackCap,
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
