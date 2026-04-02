// context-ledger — capture/classify
// Deterministic commit classifier: Tier 1 (draft_needed) or Tier 2 (question_needed).
// Zero LLM calls. Zero I/O. Pure function.

import type { LedgerConfig } from "../config.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface ClassifyResult {
  tier: 1 | 2;
  change_category: string;
  inbox_type: "draft_needed" | "question_needed";
  changed_files: string[];
}

export interface ParsedPackageJson {
  addedDeps: string[];
  removedDeps: string[];
  otherChanges: boolean;
}

// ── Path Helpers ─────────────────────────────────────────────────────────────

function norm(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "");
}

function normLower(p: string): string {
  return norm(p).toLowerCase();
}

function parentDir(p: string): string {
  const parts = norm(p).split("/");
  return parts.length > 1 ? parts.slice(0, -1).join("/") : "";
}

function isTestFile(p: string): boolean {
  const l = normLower(p);
  return /\.(test|spec)\.[^/]+$/.test(l) || l.includes("__tests__/") || l.includes("__mocks__/");
}

function isDocFile(p: string): boolean {
  const l = normLower(p);
  return l.endsWith(".md") || l.startsWith("docs/") || /^readme/i.test(l.split("/").pop() ?? "") || /^license/i.test(l.split("/").pop() ?? "") || /^changelog/i.test(l.split("/").pop() ?? "");
}

function isStyleFile(p: string): boolean {
  const l = normLower(p);
  return /\.(css|scss|less)$/.test(l) || l.includes("styles/");
}

function isIgnored(p: string, ignorePaths: string[]): boolean {
  const n = normLower(p);
  return ignorePaths.some((prefix) => n.startsWith(prefix.toLowerCase()));
}

// ── Tier 2 Detectors ─────────────────────────────────────────────────────────

const AUTH_SECURITY_PATTERN = /\b(auth|middleware|permissions|security)\b/;
const AUTH_FILE_PATTERN = /\b(credentials|oauth|jwt|session)\b/i;

function detectModuleReplacement(
  deleted: string[],
  added: string[],
): { deletedDir: string; addedDir: string; files: string[] } | null {
  // Implementation files only — not tests or docs
  const implDeleted = deleted.filter((f) => !isTestFile(f) && !isDocFile(f));
  const implAdded = added.filter((f) => !isTestFile(f) && !isDocFile(f));
  if (implDeleted.length === 0 || implAdded.length === 0) return null;

  const deletedDirs = [...new Set(implDeleted.map(parentDir))].filter(Boolean);
  const addedDirs = [...new Set(implAdded.map(parentDir))].filter(Boolean);

  for (const dd of deletedDirs) {
    for (const ad of addedDirs) {
      if (dd !== ad && dd.split("/").length === ad.split("/").length) {
        const files = [
          ...implDeleted.filter((f) => parentDir(f) === dd),
          ...implAdded.filter((f) => parentDir(f) === ad),
        ];
        return { deletedDir: dd, addedDir: ad, files };
      }
    }
  }
  return null;
}

function detectAuthSecurityChange(files: string[]): string[] {
  return files.filter((f) => {
    const n = normLower(f);
    return AUTH_SECURITY_PATTERN.test(n) || AUTH_FILE_PATTERN.test(n.split("/").pop() ?? "");
  });
}

function detectDbMigrationSwitch(deleted: string[], added: string[]): string[] | null {
  const migrationPattern = /\b(migration|schema|\.prisma|\.sql|drizzle|knex|typeorm)\b/i;
  const delMig = deleted.filter((f) => migrationPattern.test(normLower(f)));
  const addMig = added.filter((f) => migrationPattern.test(normLower(f)));
  if (delMig.length > 0 && addMig.length > 0) return [...delMig, ...addMig];
  return null;
}

function detectFeatureRemoval(deleted: string[]): { dir: string; files: string[] } | null {
  const impl = deleted.filter((f) => !isTestFile(f) && !isDocFile(f));
  const byDir = new Map<string, string[]>();
  for (const f of impl) {
    const d = parentDir(f);
    if (!d) continue;
    const list = byDir.get(d) ?? [];
    list.push(f);
    byDir.set(d, list);
  }
  for (const [dir, files] of byDir) {
    if (files.length >= 3) return { dir, files };
  }
  return null;
}

// ── Tier 1 Detectors ─────────────────────────────────────────────────────────

const CONFIG_PATTERN = /tsconfig|eslint|\.prettierrc|jest\.config|vitest\.config|\.github\/workflows/;
const ROUTE_PATTERN = /src\/app\/api\/|src\/pages\/api\/|src\/routes\//;
const SCHEMA_PATTERN = /\b(schema|migration|\.prisma|\.sql|drizzle)\b/i;

function detectNewDirectory(added: string[], changed: string[]): { dir: string; files: string[] } | null {
  const addedDirs = new Map<string, string[]>();
  for (const f of added) {
    const d = parentDir(f);
    if (!d) continue;
    const list = addedDirs.get(d) ?? [];
    list.push(f);
    addedDirs.set(d, list);
  }
  // A "new directory" means 2+ added files in a dir with NO modified files
  const changedDirs = new Set(changed.filter((f) => !added.includes(f)).map(parentDir));
  for (const [dir, files] of addedDirs) {
    if (files.length >= 2 && !changedDirs.has(dir)) return { dir, files };
  }
  return null;
}

// ── Grouping ─────────────────────────────────────────────────────────────────

function nearestCommonAncestor(files: string[]): string {
  if (files.length === 0) return "";
  const parts = files.map((f) => norm(f).split("/"));
  const min = Math.min(...parts.map((p) => p.length));
  let common = 0;
  for (let i = 0; i < min - 1; i++) {
    if (parts.every((p) => p[i] === parts[0][i])) common = i + 1;
    else break;
  }
  return parts[0].slice(0, common).join("/");
}

function dedup(files: string[]): string[] {
  return [...new Set(files)].sort();
}

// ── Main Classifier ──────────────────────────────────────────────────────────

export function classifyCommit(
  changedFiles: string[],
  deletedFiles: string[],
  addedFiles: string[],
  commitMessage: string,
  config: LedgerConfig,
  packageJsonDiff?: ParsedPackageJson | null,
): ClassifyResult[] {
  if (!config.capture.enabled) return [];

  // Normalize paths (preserve originals for output via norm, not lowercase)
  const allNorm = changedFiles.map(norm);
  const delNorm = deletedFiles.map(norm);
  const addNorm = addedFiles.map(norm);

  // Filter by ignore_paths
  const ignore = config.capture.ignore_paths;
  const all = allNorm.filter((f) => !isIgnored(f, ignore));
  const del = delNorm.filter((f) => !isIgnored(f, ignore));
  const add = addNorm.filter((f) => !isIgnored(f, ignore));

  if (all.length === 0) return [];

  // Check if ALL remaining files are test/doc/style (ignored unless new test dir)
  const hasNewTestDir = add.some(isTestFile) && detectNewDirectory(add.filter(isTestFile), []) !== null;
  const meaningful = all.filter((f) => !isTestFile(f) || hasNewTestDir)
    .filter((f) => !isDocFile(f))
    .filter((f) => !isStyleFile(f) || CONFIG_PATTERN.test(normLower(f)));

  if (meaningful.length === 0) return [];

  const results: ClassifyResult[] = [];
  const claimedFiles = new Set<string>(); // files already assigned to a result

  // ── Tier 2 (check first — higher priority) ────────────────────────────────

  // Module replacement
  const modReplace = detectModuleReplacement(del, add);
  if (modReplace) {
    results.push({
      tier: 2,
      change_category: "module-replacement",
      inbox_type: "question_needed",
      changed_files: dedup(modReplace.files),
    });
    modReplace.files.forEach((f) => claimedFiles.add(f));
  }

  // DB migration switch
  const dbSwitch = detectDbMigrationSwitch(del, add);
  if (dbSwitch) {
    results.push({
      tier: 2,
      change_category: "db-migration-switch",
      inbox_type: "question_needed",
      changed_files: dedup(dbSwitch),
    });
    dbSwitch.forEach((f) => claimedFiles.add(f));
  }

  // Auth/security changes
  const authFiles = detectAuthSecurityChange(all);
  if (authFiles.length > 0) {
    results.push({
      tier: 2,
      change_category: "auth-security-change",
      inbox_type: "question_needed",
      changed_files: dedup(authFiles),
    });
    authFiles.forEach((f) => claimedFiles.add(f));
  }

  // Feature removal (3+ non-test/doc files deleted from same dir)
  const removal = detectFeatureRemoval(del);
  if (removal && !modReplace) {
    // Only if not already caught as module-replacement
    results.push({
      tier: 2,
      change_category: "feature-removal",
      inbox_type: "question_needed",
      changed_files: dedup(removal.files),
    });
    removal.files.forEach((f) => claimedFiles.add(f));
  }

  // ── Tier 1 ─────────────────────────────────────────────────────────────────

  // Dependency changes (package.json)
  if (all.some((f) => f.endsWith("package.json") || normLower(f).endsWith("package.json"))) {
    if (packageJsonDiff) {
      if (packageJsonDiff.addedDeps.length > 0) {
        const pkgFiles = all.filter((f) => f.endsWith("package.json"));
        results.push({
          tier: 1,
          change_category: "dependency-addition",
          inbox_type: "draft_needed",
          changed_files: dedup(pkgFiles),
        });
        pkgFiles.forEach((f) => claimedFiles.add(f));
      }
      if (packageJsonDiff.removedDeps.length > 0) {
        const pkgFiles = all.filter((f) => f.endsWith("package.json"));
        results.push({
          tier: 1,
          change_category: "dependency-removal",
          inbox_type: "draft_needed",
          changed_files: dedup(pkgFiles),
        });
        pkgFiles.forEach((f) => claimedFiles.add(f));
      }
      // If only "other" changes (scripts, version) and no deps changed — ignore pkg
    } else {
      // No parsed diff available — fall back to generic dependency-change
      const pkgFiles = all.filter((f) => f.endsWith("package.json"));
      results.push({
        tier: 1,
        change_category: "dependency-change",
        inbox_type: "draft_needed",
        changed_files: dedup(pkgFiles),
      });
      pkgFiles.forEach((f) => claimedFiles.add(f));
    }
  }

  // Env var changes
  const envFiles = all.filter((f) => {
    const l = normLower(f);
    return l.endsWith(".env.example") || l.endsWith(".env.local.example");
  });
  if (envFiles.length > 0) {
    results.push({
      tier: 1,
      change_category: "env-var-change",
      inbox_type: "draft_needed",
      changed_files: dedup(envFiles),
    });
    envFiles.forEach((f) => claimedFiles.add(f));
  }

  // New directory
  const newDir = detectNewDirectory(add, all);
  if (newDir) {
    results.push({
      tier: 1,
      change_category: "new-directory",
      inbox_type: "draft_needed",
      changed_files: dedup(newDir.files),
    });
    newDir.files.forEach((f) => claimedFiles.add(f));
  }

  // File deletion (non-test, non-doc, not already caught by Tier 2)
  const unclaimed = del.filter((f) => !claimedFiles.has(f) && !isTestFile(f) && !isDocFile(f));
  if (unclaimed.length > 0) {
    results.push({
      tier: 1,
      change_category: "file-deletion",
      inbox_type: "draft_needed",
      changed_files: dedup(unclaimed),
    });
  }

  // Config changes
  const configFiles = all.filter((f) => CONFIG_PATTERN.test(normLower(f)) && !claimedFiles.has(f));
  if (configFiles.length > 0) {
    results.push({
      tier: 1,
      change_category: "config-change",
      inbox_type: "draft_needed",
      changed_files: dedup(configFiles),
    });
  }

  // API route changes
  const routeFiles = all.filter((f) => {
    const n = normLower(f);
    return (ROUTE_PATTERN.test(n) || /page\.(tsx?|jsx?)$/.test(n)) && !claimedFiles.has(f);
  });
  if (routeFiles.length > 0) {
    results.push({
      tier: 1,
      change_category: "api-route-change",
      inbox_type: "draft_needed",
      changed_files: dedup(routeFiles),
    });
  }

  // Schema changes
  const schemaFiles = all.filter((f) => SCHEMA_PATTERN.test(normLower(f)) && !claimedFiles.has(f));
  if (schemaFiles.length > 0) {
    results.push({
      tier: 1,
      change_category: "schema-change",
      inbox_type: "draft_needed",
      changed_files: dedup(schemaFiles),
    });
  }

  if (results.length === 0) return [];

  // ── Cap at 3 results: Tier 2 first, then Tier 1 by file count ─────────────

  results.sort((a, b) => {
    if (a.tier !== b.tier) return a.tier === 2 ? -1 : 1;
    return b.changed_files.length - a.changed_files.length;
  });

  if (results.length > 3) {
    const dropped = results.length - 3;
    console.error(`[context-ledger] Capped at 3 inbox items (dropped ${dropped} lower-priority classifications)`);
    return results.slice(0, 3);
  }

  return results;
}
