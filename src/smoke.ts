// context-ledger — end-to-end smoke test
// Tests the full pipeline: config → ledger write → fold → retrieval query → decision pack.
// Standalone script: exit 0 if all pass, exit 1 if any fail.

import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DecisionRecord, TransitionEvent } from "./ledger/index.js";
import {
  generateDecisionId, generateTransitionId, appendToLedger,
  foldLedger, readLedger, ledgerDir, configPath,
} from "./ledger/index.js";
import { loadConfig } from "./config.js";
import type { LedgerConfig } from "./config.js";
import { queryDecisions, searchDecisions } from "./retrieval/index.js";

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
    decision_kind: "convention",
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

async function setupTempProject(config?: Partial<LedgerConfig>): Promise<string> {
  const tmpDir = await mkdtemp(join(tmpdir(), "cl-smoke-"));
  const dir = ledgerDir(tmpDir);
  await mkdir(dir, { recursive: true });
  if (config) {
    await writeFile(configPath(tmpDir), JSON.stringify(config, null, 2) + "\n", "utf8");
  }
  return tmpDir;
}

// ── Test 1: Full pipeline — write → fold → query → decision pack ────────────

async function test1_fullPipeline(): Promise<string> {
  console.error("\nTest 1: Full pipeline (write → fold → query → decision pack)");

  const tmpDir = await setupTempProject({
    capture: {
      enabled: true,
      ignore_paths: ["dist/", "node_modules/"],
      scope_mappings: { "src/auth/": { type: "domain", id: "auth" } },
      redact_patterns: [],
      no_capture_marker: "[no-capture]",
      inbox_ttl_days: 14,
      inbox_max_prompts_per_item: 3,
      inbox_max_items_per_session: 3,
    },
    retrieval: {
      default_limit: 20,
      include_superseded: false,
      include_unreviewed: false,
      auto_promotion_min_weight: 0.7,
      token_budget: 4000,
      feature_hint_mappings: { "auth": ["auth"] },
    },
    workflow_integration: {
      selective_writeback: true,
      check_inbox_on_session_start: true,
      jit_backfill: true,
    },
    monorepo: { package_name: null, root_relative_path: null },
  } as LedgerConfig);

  const d1 = makeDecision({
    id: generateDecisionId(),
    evidence_type: "explicit_manual",
    durability: "precedent",
    summary: "Use JWT tokens for authentication",
    decision: "All API endpoints use JWT bearer tokens",
    scope: { type: "domain", id: "auth" },
    affected_files: ["src/auth/middleware.ts"],
    tags: ["auth", "security"],
    decision_kind: "convention",
  });

  const d2 = makeDecision({
    id: generateDecisionId(),
    evidence_type: "workflow_writeback",
    durability: "precedent",
    summary: "Use COALESCE for null handling in queries",
    decision: "All SQL queries use COALESCE with sensible defaults",
    scope: { type: "domain", id: "query-layer" },
    affected_files: ["src/queries/builder.ts"],
    tags: ["database", "convention"],
    decision_kind: "convention",
  });

  await appendToLedger(d1, tmpDir);
  await appendToLedger(d2, tmpDir);

  // Verify fold produces correct materialized state
  const state = await foldLedger(tmpDir);
  assert(state.decisions.size === 2, `fold produced 2 decisions (got ${state.decisions.size})`);
  assert(state.decisions.get(d1.id)!.state === "active", "d1 is active");
  assert(state.decisions.get(d2.id)!.state === "active", "d2 is active");

  // Query via file_path — should resolve to auth scope via config mapping
  const pack1 = await queryDecisions({ file_path: "src/auth/middleware.ts" }, tmpDir);
  assert(pack1.derived_scope !== null, "file_path query derived a scope");
  assert(pack1.derived_scope?.id === "auth", `derived scope id is "auth" (got "${pack1.derived_scope?.id}")`);
  assert(pack1.active_precedents.length >= 1, `file_path query returned ≥1 precedent (got ${pack1.active_precedents.length})`);
  assert(
    pack1.active_precedents.some(p => p.record.id === d1.id),
    "file_path query returned the auth decision",
  );

  // Query via natural language — broad fallback
  const pack2 = await queryDecisions({ query: "authentication" }, tmpDir);
  assert(pack2.active_precedents.length >= 1, `query "authentication" returned ≥1 precedent (got ${pack2.active_precedents.length})`);

  // Verify token estimate is populated
  assert(pack1.token_estimate > 0, `token_estimate > 0 (got ${pack1.token_estimate})`);
  assert(typeof pack1.truncated === "boolean", "truncated field is boolean");

  return tmpDir;
}

// ── Test 2: Supersede flows through to retrieval ─────────────────────────────

async function test2_supersedeFilters(): Promise<string> {
  console.error("\nTest 2: Supersede filters from default query");

  const tmpDir = await setupTempProject();

  const d1 = makeDecision({
    id: generateDecisionId(),
    evidence_type: "explicit_manual",
    durability: "precedent",
    summary: "Use REST for API",
    scope: { type: "domain", id: "api" },
  });
  const d2 = makeDecision({
    id: generateDecisionId(),
    evidence_type: "explicit_manual",
    durability: "precedent",
    summary: "Use GraphQL for API",
    scope: { type: "domain", id: "api" },
  });

  await appendToLedger(d1, tmpDir);
  await appendToLedger(d2, tmpDir);
  await appendToLedger(makeTransition({
    target_id: d1.id,
    action: "supersede",
    replaced_by: d2.id,
    reason: "Migrating to GraphQL",
  }), tmpDir);

  // Default query excludes superseded
  const pack = await queryDecisions({ query: "API" }, tmpDir);
  const ids = pack.active_precedents.map(p => p.record.id);
  assert(!ids.includes(d1.id), "superseded decision excluded from active_precedents");
  assert(ids.includes(d2.id), "replacement decision included in active_precedents");

  // recently_superseded populates only with include_superseded: true
  const packWithSuperseded = await queryDecisions({ query: "API", include_superseded: true }, tmpDir);
  assert(
    packWithSuperseded.recently_superseded.some(s => s.record.id === d1.id),
    "superseded decision appears in recently_superseded (with include_superseded)",
  );

  return tmpDir;
}

// ── Test 3: Config loading — defaults and override merge ─────────────────────

async function test3_configLoading(): Promise<string> {
  console.error("\nTest 3: Config loading and merge behavior");

  // No config file — should return defaults
  const tmpDir1 = await setupTempProject();
  const defaultConfig = await loadConfig(tmpDir1);
  assert(defaultConfig.capture.enabled === true, "default capture.enabled is true");
  assert(defaultConfig.retrieval.token_budget === 4000, "default token_budget is 4000");
  assert(Object.keys(defaultConfig.capture.scope_mappings).length === 0, "default scope_mappings is empty");

  // With config file — partial override merges over defaults
  const tmpDir2 = await setupTempProject({
    capture: {
      enabled: false,
      ignore_paths: ["custom/"],
      scope_mappings: { "src/": { type: "domain", id: "root" } },
      redact_patterns: [],
      no_capture_marker: "[no-capture]",
      inbox_ttl_days: 14,
      inbox_max_prompts_per_item: 3,
      inbox_max_items_per_session: 3,
    },
    retrieval: {
      default_limit: 20,
      include_superseded: false,
      include_unreviewed: false,
      auto_promotion_min_weight: 0.7,
      token_budget: 2000,
      feature_hint_mappings: {},
    },
    workflow_integration: {
      selective_writeback: true,
      check_inbox_on_session_start: true,
      jit_backfill: true,
    },
    monorepo: { package_name: null, root_relative_path: null },
  } as LedgerConfig);
  const overrideConfig = await loadConfig(tmpDir2);
  assert(overrideConfig.capture.enabled === false, "overridden capture.enabled is false");
  assert(overrideConfig.retrieval.token_budget === 2000, "overridden token_budget is 2000");
  assert("src/" in overrideConfig.capture.scope_mappings, "scope_mappings has src/ key");

  return tmpDir2;
}

// ── Test 4: searchDecisions lexical search ───────────────────────────────────

async function test4_searchDecisions(): Promise<string> {
  console.error("\nTest 4: searchDecisions lexical search");

  const tmpDir = await setupTempProject();

  const d1 = makeDecision({
    id: generateDecisionId(),
    evidence_type: "explicit_manual",
    durability: "precedent",
    summary: "Use PostgreSQL COALESCE for null handling",
    decision: "Always wrap nullable columns with COALESCE",
    tags: ["database", "sql"],
  });
  const d2 = makeDecision({
    id: generateDecisionId(),
    evidence_type: "explicit_manual",
    durability: "precedent",
    summary: "Use Redis for session caching",
    decision: "Session data goes to Redis, not database",
    tags: ["caching"],
  });

  await appendToLedger(d1, tmpDir);
  await appendToLedger(d2, tmpDir);

  const results = await searchDecisions("COALESCE null", tmpDir);
  assert(results.length >= 1, `search "COALESCE null" found ≥1 result (got ${results.length})`);
  assert(results[0].record.id === d1.id, "top result is the COALESCE decision");

  const noResults = await searchDecisions("nonexistent-term-xyz", tmpDir);
  assert(noResults.length === 0, "search for nonexistent term returns 0 results");

  return tmpDir;
}

// ── Test 5: Reinforce affects retrieval weight ───────────────────────────────

async function test5_reinforceWeight(): Promise<string> {
  console.error("\nTest 5: Reinforce increases effective rank score");

  const tmpDir = await setupTempProject();

  const d = makeDecision({
    id: generateDecisionId(),
    evidence_type: "confirmed_draft",
    durability: "precedent",
    summary: "Use server components by default",
    scope: { type: "domain", id: "frontend" },
  });

  await appendToLedger(d, tmpDir);

  // Check baseline
  const state1 = await foldLedger(tmpDir);
  const baseline = state1.decisions.get(d.id)!.effective_rank_score;

  // Reinforce twice (distinct reasons so they're not treated as idempotent duplicates)
  await appendToLedger(makeTransition({ target_id: d.id, action: "reinforce", source_feature_id: "f1", reason: "Confirmed in feature f1" }), tmpDir);
  await appendToLedger(makeTransition({ target_id: d.id, action: "reinforce", source_feature_id: "f2", reason: "Confirmed in feature f2" }), tmpDir);

  const state2 = await foldLedger(tmpDir);
  const boosted = state2.decisions.get(d.id)!.effective_rank_score;

  assert(boosted > baseline, `rank score increased after reinforce (${baseline} → ${boosted})`);
  assert(boosted <= 1.0, `rank score capped at 1.0 (got ${boosted})`);
  assert(state2.decisions.get(d.id)!.reinforcement_count === 2, "reinforcement_count is 2");

  // Verify it shows up in query with boosted weight
  const pack = await queryDecisions({ query: "server components" }, tmpDir);
  assert(pack.active_precedents.length >= 1, "reinforced decision appears in query");

  return tmpDir;
}

// ── Runner ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.error("context-ledger end-to-end smoke test\n====================================");

  const dirs: string[] = [];

  try {
    for (const testFn of [
      test1_fullPipeline,
      test2_supersedeFilters,
      test3_configLoading,
      test4_searchDecisions,
      test5_reinforceWeight,
    ]) {
      const dir = await testFn();
      dirs.push(dir);
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
