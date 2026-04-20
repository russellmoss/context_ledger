// context-ledger — config
// Configuration types, defaults, and loader for .context-ledger/config.json.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ScopeType } from "./ledger/index.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface ScopeMapping {
  type: ScopeType;
  id: string;
}

export interface DrafterCaptureConfig {
  enabled: boolean;
  model?: string;
  timeout_ms?: number;
  max_diff_chars?: number;
  revert_suppression_window_hours?: number;
}

export interface SeedRulesConfig {
  gitignore_trivial?: boolean;  // default: true — suppress single-line .gitignore-only commits
  ide_config_only?: boolean;    // default: true — suppress commits touching only per-developer IDE config dirs
  lockfile_only?: boolean;      // default: true — suppress commits changing only lockfiles without their manifests
}

export interface ClassifierCaptureConfig {
  editor_backup_patterns: string[];
  seed_rules?: SeedRulesConfig;
}

export interface LedgerConfig {
  capture: {
    enabled: boolean;
    ignore_paths: string[];
    scope_mappings: Record<string, ScopeMapping>;
    redact_patterns: string[];
    no_capture_marker: string;
    inbox_ttl_days: number;
    inbox_max_prompts_per_item: number;
    inbox_max_items_per_session: number;
    drafter: DrafterCaptureConfig;
    classifier?: ClassifierCaptureConfig;
  };
  retrieval: {
    default_limit: number;
    include_superseded: boolean;
    include_unreviewed: boolean;
    auto_promotion_min_weight: number;
    token_budget: number;
    feature_hint_mappings: Record<string, string[]>;
  };
  workflow_integration: {
    selective_writeback: boolean;
    check_inbox_on_session_start: boolean;
    jit_backfill: boolean;
  };
  monorepo: {
    package_name: string | null;
    root_relative_path: string | null;
  };
}

// ── Defaults ─────────────────────────────────────────────────────────────────

export const DEFAULT_CONFIG: LedgerConfig = {
  capture: {
    enabled: true,
    ignore_paths: ["dist/", "node_modules/", ".next/", "coverage/", ".agent-guard/", ".cursor/", ".claude/"],
    scope_mappings: {},
    redact_patterns: [],
    no_capture_marker: "[no-capture]",
    inbox_ttl_days: 14,
    inbox_max_prompts_per_item: 3,
    inbox_max_items_per_session: 3,
    drafter: { enabled: true, revert_suppression_window_hours: 24 },
    classifier: {
      editor_backup_patterns: ["*.bak", "*.orig", "*.swp", "*.swo", "*~", ".#*", ".DS_Store", "Thumbs.db"],
      seed_rules: {
        gitignore_trivial: true,
        ide_config_only: true,
        lockfile_only: true,
      },
    },
  },
  retrieval: {
    default_limit: 20,
    include_superseded: false,
    include_unreviewed: false,
    auto_promotion_min_weight: 0.7,
    token_budget: 4000,
    feature_hint_mappings: {},
  },
  workflow_integration: {
    selective_writeback: true,
    check_inbox_on_session_start: true,
    jit_backfill: true,
  },
  monorepo: {
    package_name: null,
    root_relative_path: null,
  },
};

// ── Loader ───────────────────────────────────────────────────────────────────

export async function loadConfig(projectRoot: string): Promise<LedgerConfig> {
  const filePath = join(projectRoot, ".context-ledger", "config.json");
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (err: any) {
    if (err.code === "ENOENT") return DEFAULT_CONFIG;
    throw err;
  }
  const fileConfig = JSON.parse(raw) as Partial<LedgerConfig>;
  return deepMerge(DEFAULT_CONFIG, fileConfig);
}

// ── Deep Merge Helper ────────────────────────────────────────────────────────

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepMerge(defaults: any, overrides: any): any {
  const result = { ...defaults };
  for (const key of Object.keys(overrides)) {
    const overrideVal = overrides[key];
    const defaultVal = defaults[key];
    if (overrideVal === undefined) continue;
    if (overrideVal === null || Array.isArray(overrideVal) || !isPlainObject(overrideVal)) {
      result[key] = overrideVal;
    } else if (isPlainObject(defaultVal)) {
      result[key] = deepMerge(defaultVal, overrideVal);
    } else {
      result[key] = overrideVal;
    }
  }
  return result;
}
