// context-ledger — ledger/events
// Type definitions, constants, ID generators, and type guards for the event-sourced ledger.

// ── Type Aliases ──────────────────────────────────────────────────────────────

export type EvidenceType =
  | "human_answered"
  | "explicit_manual"
  | "workflow_writeback"
  | "corrected_draft"
  | "confirmed_draft"
  | "backfill_confirmed"
  | "commit_inferred";

export type ScopeType = "package" | "directory" | "domain" | "concern" | "integration";

export type TransitionAction = "supersede" | "abandon" | "expire" | "reopen" | "reinforce";

export type LifecycleState = "active" | "superseded" | "abandoned" | "expired";

export type Durability = "precedent" | "feature-local" | "temporary-workaround";

export type VerificationStatus = "unreviewed" | "confirmed" | "corrected" | "rejected";

export type DecisionSource = "manual" | "workflow-writeback" | "commit-inferred" | "backfill";

export type InboxStatus = "pending" | "confirmed" | "corrected" | "dismissed" | "expired" | "ignored";

export type InboxType = "draft_needed" | "question_needed";

// ── Interfaces ────────────────────────────────────────────────────────────────

export interface AlternativeConsidered {
  approach: string;
  why_rejected: string;
  failure_conditions: string | null;
}

export interface DecisionScope {
  type: ScopeType;
  id: string;
}

export interface DecisionRecord {
  type: "decision";
  id: string;
  created: string;
  source: DecisionSource;
  evidence_type: EvidenceType;
  verification_status: VerificationStatus;
  commit_sha: string | null;
  summary: string;
  decision: string;
  alternatives_considered: AlternativeConsidered[];
  rationale: string;
  revisit_conditions: string;
  review_after: string | null;
  scope: DecisionScope;
  affected_files: string[];
  scope_aliases: string[];
  decision_kind: string;
  tags: string[];
  durability: Durability;
}

export interface TransitionEvent {
  type: "transition";
  id: string;
  created: string;
  target_id: string;
  action: TransitionAction;
  replaced_by: string | null;
  reason: string;
  pain_points: string[] | null;
  source_feature_id: string | null;
}

export interface ProposedDecisionDraft {
  summary: string;
  decision: string;
  rationale: string;
  alternatives_considered: AlternativeConsidered[];
  decision_kind: string;
  tags: string[];
  durability: Durability;
  scope_type?: ScopeType;
  scope_id?: string;
  affected_files?: string[];
  scope_aliases?: string[];
  revisit_conditions?: string;
  review_after?: string | null;
}

export interface InboxItem {
  inbox_id: string;
  type: InboxType;
  created: string;
  commit_sha: string;
  commit_message: string;
  change_category: string;
  changed_files: string[];
  diff_summary: string;
  priority: "normal";
  expires_after: string;
  times_shown: number;
  last_prompted_at: string | null;
  status: InboxStatus;
  proposed_record?: ProposedDecisionDraft;
  proposed_decision?: ProposedDecisionDraft;
  rejection_reason?: string;
}

// ── Union Type ────────────────────────────────────────────────────────────────

export type LedgerEvent = DecisionRecord | TransitionEvent;

// ── Constants ─────────────────────────────────────────────────────────────────

export const RETRIEVAL_WEIGHTS: Record<EvidenceType, number> = {
  human_answered: 1.0,
  explicit_manual: 1.0,
  workflow_writeback: 0.9,
  corrected_draft: 0.85,
  confirmed_draft: 0.8,
  backfill_confirmed: 0.7,
  commit_inferred: 0.2,
};

// ── ID Generators ─────────────────────────────────────────────────────────────

export function generateDecisionId(): string {
  const unix = Math.floor(Date.now() / 1000);
  const hex = Math.floor(Math.random() * 0xffff).toString(16).padStart(4, "0");
  return `d_${unix}_${hex}`;
}

export function generateTransitionId(): string {
  const unix = Math.floor(Date.now() / 1000);
  const hex = Math.floor(Math.random() * 0xffff).toString(16).padStart(4, "0");
  return `t_${unix}_${hex}`;
}

export function generateInboxId(): string {
  const unix = Math.floor(Date.now() / 1000);
  const hex = Math.floor(Math.random() * 0xff).toString(16).padStart(2, "0");
  return `q_${unix}_${hex}`;
}

// ── Type Guards ───────────────────────────────────────────────────────────────

export function isDecisionRecord(event: LedgerEvent): event is DecisionRecord {
  return event.type === "decision";
}

export function isTransitionEvent(event: LedgerEvent): event is TransitionEvent {
  return event.type === "transition";
}

export function isInboxItem(obj: unknown): obj is InboxItem {
  return typeof obj === "object" && obj !== null && typeof (obj as any).inbox_id === "string";
}
