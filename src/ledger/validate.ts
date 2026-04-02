// context-ledger — ledger/validate
// Integrity checks and repair suggestions for the event-sourced ledger.

import { readFile } from "node:fs/promises";
import { access } from "node:fs/promises";
import { resolve } from "node:path";
import type { FoldedDecision, MaterializedState } from "./fold.js";
import { foldLedger } from "./fold.js";
import { readInbox } from "./storage.js";
import { ledgerPath, inboxPath } from "./storage.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface ValidationReport {
  errors: string[];
  warnings: string[];
  passed: boolean;
}

export interface RepairAction {
  type: "review" | "update";
  message: string;
}

export interface RepairPlan {
  report: ValidationReport;
  actions: RepairAction[];
}

// ── Validate ─────────────────────────────────────────────────────────────────

export async function validateLedger(
  projectRoot: string,
  options?: { strict?: boolean },
): Promise<ValidationReport> {
  const errors: string[] = [];
  const warnings: string[] = [];

  // 1. Raw JSONL line-by-line check BEFORE folding (Council fix C6)
  for (const [label, filePath] of [
    ["ledger", ledgerPath(projectRoot)],
    ["inbox", inboxPath(projectRoot)],
  ] as const) {
    try {
      const raw = await readFile(filePath, "utf8");
      const lines = raw.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (line === "") continue;
        try {
          JSON.parse(line);
        } catch {
          errors.push(`Malformed JSON on line ${i + 1} of ${label}.jsonl`);
        }
      }
    } catch (err: any) {
      if (err.code !== "ENOENT") errors.push(`Cannot read ${label}: ${err.message}`);
    }
  }

  // 2. Fold with strict: false to collect lifecycle warnings
  const state = await foldLedger(projectRoot, { strict: options?.strict ?? false });
  const inbox = await readInbox(projectRoot);
  const decisions = Array.from(state.decisions.values());
  errors.push(...state.warnings);

  // 3. Stale file references (D3: warnings only, not errors)
  for (const d of decisions) {
    if (d.state !== "active") continue;
    for (const fp of d.record.affected_files) {
      try {
        await access(resolve(projectRoot, fp));
      } catch {
        warnings.push(`Stale file reference in ${d.record.id}: ${fp} does not exist`);
      }
    }
  }

  // 4. Inbox structural integrity
  for (const item of inbox) {
    if (!item.inbox_id || !item.status || !item.created) {
      errors.push(`Malformed inbox item: missing required fields (id=${item.inbox_id})`);
    }
  }

  return { errors, warnings, passed: errors.length === 0 };
}

// ── Propose Repair ───────────────────────────────────────────────────────────

export async function proposeRepair(projectRoot: string): Promise<RepairPlan> {
  const report = await validateLedger(projectRoot);

  // Fold again to get materialized state for analysis
  const state = await foldLedger(projectRoot, { strict: false });
  const decisions = Array.from(state.decisions.values());
  const actions: RepairAction[] = [];

  // Near-duplicate detection: same scope + multiple active decisions
  const activeByScope = new Map<string, FoldedDecision[]>();
  for (const d of decisions) {
    if (d.state !== "active") continue;
    const scopeKey = `${d.record.scope.type}/${d.record.scope.id}`;
    if (!activeByScope.has(scopeKey)) activeByScope.set(scopeKey, []);
    activeByScope.get(scopeKey)!.push(d);
  }

  for (const [scopeKey, scopeDecisions] of activeByScope) {
    if (scopeDecisions.length < 2) continue;
    actions.push({
      type: "review",
      message: `Scope "${scopeKey}" has ${scopeDecisions.length} active decisions: ${scopeDecisions.map(d => d.record.id).join(", ")}. Consider superseding duplicates.`,
    });
  }

  // Stale scope aliases
  for (const d of decisions) {
    if (d.state !== "active") continue;
    for (const alias of d.record.scope_aliases) {
      try {
        await access(resolve(projectRoot, alias));
      } catch {
        actions.push({
          type: "update",
          message: `Scope alias "${alias}" in ${d.record.id} no longer exists. Consider removing or updating.`,
        });
      }
    }
  }

  return { report, actions };
}
