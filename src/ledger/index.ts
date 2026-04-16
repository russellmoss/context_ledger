// context-ledger — ledger barrel exports

export type {
  EvidenceType,
  ScopeType,
  TransitionAction,
  LifecycleState,
  Durability,
  VerificationStatus,
  DecisionSource,
  InboxStatus,
  InboxType,
  LedgerEvent,
  AlternativeConsidered,
  DecisionScope,
  DecisionRecord,
  TransitionEvent,
  InboxItem,
  ProposedDecisionDraft,
} from "./events.js";

export {
  RETRIEVAL_WEIGHTS,
  generateDecisionId,
  generateTransitionId,
  generateInboxId,
  isDecisionRecord,
  isTransitionEvent,
  isInboxItem,
} from "./events.js";

export {
  ledgerDir,
  ledgerPath,
  inboxPath,
  configPath,
  appendToLedger,
  readLedger,
  appendToInbox,
  readInbox,
  rewriteInbox,
} from "./storage.js";

export type {
  FoldedDecision,
  MaterializedState,
  FoldOptions,
} from "./fold.js";

export {
  LedgerIntegrityError,
  foldEvents,
  foldLedger,
  computeEffectiveRankScore,
} from "./fold.js";

export {
  tidyInbox,
  expireStaleItems,
  getPendingItems,
  updateInboxItem,
} from "./inbox.js";

export type {
  ValidationReport,
  RepairAction,
  RepairPlan,
} from "./validate.js";

export {
  validateLedger,
  proposeRepair,
} from "./validate.js";
