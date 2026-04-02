// context-ledger — retrieval/scope
// Scope derivation: file path → config mapping → scope alias → directory fallback → feature hints → recency.

import type { ScopeType, FoldedDecision } from "../ledger/index.js";
import type { LedgerConfig } from "../config.js";

// ── Types ────────────────────────────────────────────────────────────────────

export type ScopeSource =
  | "explicit"
  | "config_mapping"
  | "scope_alias"
  | "directory_fallback"
  | "feature_hint"
  | "recency_fallback";

export interface DerivedScope {
  type: ScopeType;
  id: string;
  source: ScopeSource;
}

// ── Path Normalization ───────────────────────────────────────────────────────

export function normalizePath(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
}

// ── Main Scope Derivation ────────────────────────────────────────────────────

export function deriveScope(
  params: { file_path?: string; query?: string; scope_type?: string; scope_id?: string },
  config: LedgerConfig,
  decisions: Map<string, FoldedDecision>,
): DerivedScope | null {
  // Step 1 — Explicit params
  if (params.scope_type && params.scope_id) {
    return { type: params.scope_type as ScopeType, id: params.scope_id, source: "explicit" };
  }

  // Step 2 — File path derivation
  if (params.file_path) {
    const normalized = normalizePath(params.file_path);

    // 2a: Config mapping (longest prefix match)
    const mappingKeys = Object.keys(config.capture.scope_mappings)
      .map((k) => normalizePath(k))
      .sort((a, b) => b.length - a.length);

    for (const key of mappingKeys) {
      if (normalized.startsWith(key)) {
        // Find original key to look up the mapping value
        const originalKey = Object.keys(config.capture.scope_mappings).find(
          (k) => normalizePath(k) === key,
        )!;
        const mapping = config.capture.scope_mappings[originalKey];
        const resolved = normalizeScopeMapping(mapping);
        if (resolved) {
          return { type: resolved.type, id: resolved.id, source: "config_mapping" };
        }
      }
    }

    // 2b: Scope alias (from DecisionRecord.scope_aliases[])
    for (const folded of decisions.values()) {
      if (folded.state !== "active") continue;
      for (const alias of folded.record.scope_aliases) {
        const normalizedAlias = normalizePath(alias);
        if (normalized.startsWith(normalizedAlias) || normalized === normalizedAlias) {
          return { type: folded.record.scope.type, id: folded.record.scope.id, source: "scope_alias" };
        }
      }
    }

    // 2c: Directory fallback
    const segments = normalized.split("/").filter((s) => s !== "" && s !== "." && s !== "..");
    const srcIndex = segments.indexOf("src");
    let scopeId: string | null = null;

    if (srcIndex >= 0 && srcIndex + 1 < segments.length) {
      scopeId = segments[srcIndex + 1];
    } else if (segments.length >= 2) {
      // No src/ segment — use first meaningful directory segment
      scopeId = segments[0];
    }

    if (scopeId) {
      return { type: "directory", id: scopeId, source: "directory_fallback" };
    }
  }

  // Step 3 — Feature hint mappings
  if (params.query) {
    const matched = deriveScopeFromHints(params.query, config.retrieval.feature_hint_mappings);
    if (matched.length > 0) {
      return { type: "domain", id: matched[0], source: "feature_hint" };
    }
  }

  // Step 4 — Pure recency fallback (caller handles null)
  return null;
}

// ── Feature Hint Matching ────────────────────────────────────────────────────

export function deriveScopeFromHints(
  query: string,
  featureHintMappings: Record<string, string[]>,
): string[] {
  const tokens = query.toLowerCase().split(/[\s\W]+/).filter((t) => t.length > 0);
  const matched: string[] = [];

  for (const [keyword, scopeIds] of Object.entries(featureHintMappings)) {
    if (tokens.includes(keyword.toLowerCase())) {
      for (const id of scopeIds) {
        if (!matched.includes(id)) {
          matched.push(id);
        }
      }
    }
  }

  return matched;
}

// ── Scope Mapping Normalization ─────────────────────────────────────────────

/**
 * Accepts both canonical { type, id } format and shorthand like { domain: "query-layer" }.
 * Returns null if the mapping is empty or unrecognizable.
 */
function normalizeScopeMapping(mapping: any): { type: ScopeType; id: string } | null {
  // Canonical format: { type: "domain", id: "query-layer" }
  if (mapping && typeof mapping.type === "string" && typeof mapping.id === "string") {
    return { type: mapping.type as ScopeType, id: mapping.id };
  }

  // Shorthand format: { domain: "query-layer" } — first key is type, value is id
  if (mapping && typeof mapping === "object") {
    const keys = Object.keys(mapping);
    if (keys.length === 1) {
      const type = keys[0];
      const id = mapping[type];
      if (typeof id === "string") {
        return { type: type as ScopeType, id };
      }
    }
  }

  return null;
}
