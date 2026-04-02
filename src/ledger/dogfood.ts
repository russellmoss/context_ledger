// context-ledger — dogfood script
// Uses the ledger to capture a real decision about its own architecture.

import { generateDecisionId } from "./events.js";
import { appendToLedger, readLedger } from "./storage.js";
import { foldEvents } from "./fold.js";
import type { DecisionRecord } from "./events.js";

async function main(): Promise<void> {
  const projectRoot = process.cwd();

  const decision: DecisionRecord = {
    type: "decision",
    id: generateDecisionId(),
    created: new Date().toISOString(),
    source: "workflow-writeback",
    evidence_type: "workflow_writeback",
    verification_status: "confirmed",
    commit_sha: null,
    summary: "Event fold uses log order not timestamp order",
    decision: "Events are processed in JSONL line order (array index), not sorted by created timestamp",
    alternatives_considered: [
      {
        approach: "Sort by created timestamp before folding",
        why_rejected: "Backfill events would interleave with original events, changing historical fold results",
        failure_conditions: null,
      },
    ],
    rationale: "Prevents backfill events from being reordered into history, which would change fold results non-deterministically",
    revisit_conditions: "If we add multi-device sync where append order is not guaranteed",
    review_after: null,
    scope: { type: "domain", id: "ledger-fold" },
    affected_files: ["src/ledger/fold.ts"],
    scope_aliases: [],
    decision_kind: "processing-order",
    tags: ["fold", "event-sourcing", "determinism"],
    durability: "precedent",
  };

  await appendToLedger(decision, projectRoot);

  const events = await readLedger(projectRoot);
  const state = foldEvents(events);

  // Find the decision we just wrote
  let found = false;
  for (const folded of state.decisions.values()) {
    if (folded.record.summary === "Event fold uses log order not timestamp order") {
      if (folded.state !== "active") {
        console.error(`FAIL: expected state "active", got "${folded.state}"`);
        process.exit(1);
      }
      if (folded.effective_rank_score !== 0.9) {
        console.error(`FAIL: expected effective_rank_score 0.9, got ${folded.effective_rank_score}`);
        process.exit(1);
      }
      found = true;
      break;
    }
  }

  if (!found) {
    console.error("FAIL: could not find the dogfood decision in folded state");
    process.exit(1);
  }

  console.error("context-ledger successfully captured and retrieved a decision about itself.");
}

main();
