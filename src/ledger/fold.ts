// context-ledger — ledger/fold
// Event fold logic: replays events to compute current materialized state.

import type {
  DecisionRecord,
  TransitionEvent,
  LedgerEvent,
  LifecycleState,
  EvidenceType,
} from "./events.js";
import { RETRIEVAL_WEIGHTS, isDecisionRecord, isTransitionEvent } from "./events.js";
import { readLedger } from "./storage.js";

// ── Interfaces ────────────────────────────────────────────────────────────────

export interface FoldedDecision {
  record: DecisionRecord;
  state: LifecycleState;
  replaced_by: string | null;
  reinforcement_count: number;
  effective_rank_score: number;
  transitions: TransitionEvent[];
}

export interface MaterializedState {
  decisions: Map<string, FoldedDecision>;
  warnings: string[];
}

export interface FoldOptions {
  now?: number;
  strict?: boolean;
}

// ── Error Class ───────────────────────────────────────────────────────────────

export class LedgerIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LedgerIntegrityError";
  }
}

// ── Helper Functions ──────────────────────────────────────────────────────────

export function computeEffectiveRankScore(baseWeight: number, reinforcementCount: number): number {
  return Math.min(1.0, baseWeight + Math.min(0.15, 0.05 * reinforcementCount));
}

// ── Core Fold ─────────────────────────────────────────────────────────────────

export function foldEvents(events: LedgerEvent[], options?: FoldOptions): MaterializedState {
  const { now: nowTs = Date.now(), strict = false } = options ?? {};
  const decisions = new Map<string, FoldedDecision>();
  const warnings: string[] = [];

  function warn(msg: string): void {
    if (strict) throw new LedgerIntegrityError(msg);
    warnings.push(msg);
  }

  // ── Process events in log append order ──────────────────────────────────

  for (const event of events) {
    if (isDecisionRecord(event)) {
      if (decisions.has(event.id)) {
        warn(`Duplicate decision ID: ${event.id}`);
        continue;
      }
      decisions.set(event.id, {
        record: event,
        state: "active",
        replaced_by: null,
        reinforcement_count: 0,
        effective_rank_score: RETRIEVAL_WEIGHTS[event.evidence_type],
        transitions: [],
      });
    } else if (isTransitionEvent(event)) {
      applyTransition(event, decisions, warn);
    }
  }

  // ── Feature-local auto-expiry ───────────────────────────────────────────

  const sixtyDaysMs = 60 * 24 * 60 * 60 * 1000;

  for (const folded of decisions.values()) {
    if (folded.record.durability !== "feature-local") continue;
    if (folded.state !== "active") continue;

    // Find most recent reopen transition to determine baseline date
    let baselineDate = folded.record.created;
    for (let i = folded.transitions.length - 1; i >= 0; i--) {
      if (folded.transitions[i].action === "reopen") {
        baselineDate = folded.transitions[i].created;
        break;
      }
    }

    if (nowTs > new Date(baselineDate).getTime() + sixtyDaysMs) {
      folded.state = "expired";
    }
  }

  return { decisions, warnings };
}

// ── Convenience Wrapper ───────────────────────────────────────────────────────

export async function foldLedger(projectRoot: string, options?: FoldOptions): Promise<MaterializedState> {
  const events = await readLedger(projectRoot);
  return foldEvents(events, options);
}

// ── Transition Application ────────────────────────────────────────────────────

function applyTransition(
  event: TransitionEvent,
  decisions: Map<string, FoldedDecision>,
  warn: (msg: string) => void,
): void {
  const target = decisions.get(event.target_id);
  if (!target) {
    warn(`Transition ${event.id} targets non-existent decision ${event.target_id}`);
    return;
  }

  // Idempotency check: compare against most recent same-action transition
  // A transition is a no-op duplicate only if:
  //   1. The target's current state already reflects that action
  //   2. The most recent same-action transition has same reason, replaced_by, pain_points
  const lastSameAction = findLastSameAction(target.transitions, event.action);
  if (lastSameAction && isIdempotentDuplicate(event, lastSameAction, target.state)) {
    // Push to audit trail but don't apply state change
    target.transitions.push(event);
    return;
  }

  // Apply action
  switch (event.action) {
    case "supersede": {
      if (target.state !== "active") {
        warn(`Cannot supersede decision ${event.target_id}: state is "${target.state}", expected "active"`);
        target.transitions.push(event);
        return;
      }
      if (event.replaced_by === null) {
        warn(`Supersede transition ${event.id} missing replaced_by`);
        target.transitions.push(event);
        return;
      }
      if (event.target_id === event.replaced_by) {
        warn(`Self-supersede rejected: ${event.target_id} cannot supersede itself`);
        target.transitions.push(event);
        return;
      }
      if (!decisions.has(event.replaced_by)) {
        warn(`Supersede transition ${event.id}: replaced_by "${event.replaced_by}" does not exist`);
        target.transitions.push(event);
        return;
      }
      // Full cycle detection: walk supersession chain from replaced_by upward
      if (hasSupersessionCycle(event.target_id, event.replaced_by, decisions)) {
        warn(`Cycle detected: superseding ${event.target_id} with ${event.replaced_by} would create a cycle`);
        target.transitions.push(event);
        return;
      }
      target.state = "superseded";
      target.replaced_by = event.replaced_by;
      break;
    }
    case "abandon": {
      if (target.state !== "active") {
        warn(`Cannot abandon decision ${event.target_id}: state is "${target.state}", expected "active"`);
        target.transitions.push(event);
        return;
      }
      target.state = "abandoned";
      break;
    }
    case "expire": {
      if (target.state !== "active") {
        warn(`Cannot expire decision ${event.target_id}: state is "${target.state}", expected "active"`);
        target.transitions.push(event);
        return;
      }
      target.state = "expired";
      break;
    }
    case "reopen": {
      if (target.state !== "abandoned" && target.state !== "expired") {
        warn(`Cannot reopen decision ${event.target_id}: state is "${target.state}", expected "abandoned" or "expired"`);
        target.transitions.push(event);
        return;
      }
      target.state = "active";
      break;
    }
    case "reinforce": {
      if (target.state !== "active") {
        warn(`Cannot reinforce decision ${event.target_id}: state is "${target.state}", expected "active"`);
        target.transitions.push(event);
        return;
      }
      target.reinforcement_count++;
      target.effective_rank_score = computeEffectiveRankScore(
        RETRIEVAL_WEIGHTS[target.record.evidence_type],
        target.reinforcement_count,
      );
      break;
    }
  }

  target.transitions.push(event);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function findLastSameAction(
  transitions: TransitionEvent[],
  action: string,
): TransitionEvent | undefined {
  for (let i = transitions.length - 1; i >= 0; i--) {
    if (transitions[i].action === action) return transitions[i];
  }
  return undefined;
}

function isIdempotentDuplicate(
  incoming: TransitionEvent,
  last: TransitionEvent,
  currentState: LifecycleState,
): boolean {
  // State must already reflect the action
  const stateReflectsAction =
    (incoming.action === "supersede" && currentState === "superseded") ||
    (incoming.action === "abandon" && currentState === "abandoned") ||
    (incoming.action === "expire" && currentState === "expired") ||
    (incoming.action === "reopen" && currentState === "active") ||
    (incoming.action === "reinforce" && currentState === "active");

  if (!stateReflectsAction) return false;

  // Compare fields
  return (
    incoming.reason === last.reason &&
    incoming.replaced_by === last.replaced_by &&
    JSON.stringify(incoming.pain_points) === JSON.stringify(last.pain_points)
  );
}

function hasSupersessionCycle(
  targetId: string,
  replacedById: string,
  decisions: Map<string, FoldedDecision>,
): boolean {
  // Walk the supersession chain starting from replacedById.
  // If we encounter targetId, there's a cycle.
  const visited = new Set<string>();
  let current: string | null = replacedById;

  while (current !== null) {
    if (current === targetId) return true;
    if (visited.has(current)) break; // already-seen node, no cycle involving targetId
    visited.add(current);

    const decision = decisions.get(current);
    if (!decision || decision.state !== "superseded") break;
    current = decision.replaced_by;
  }

  return false;
}
