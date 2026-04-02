// context-ledger — retrieval
// Barrel exports for the retrieval module.

export type { ScopeSource, DerivedScope } from "./scope.js";
export { deriveScope, deriveScopeFromHints, normalizePath } from "./scope.js";

export type { MatchReason, PackEntry, AbandonedEntry, SupersededEntry, DecisionPack } from "./packs.js";
export { buildDecisionPack } from "./packs.js";

export type { QueryDecisionsParams, SearchResult } from "./query.js";
export { queryDecisions, searchDecisions } from "./query.js";
