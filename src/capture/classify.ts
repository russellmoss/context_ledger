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

export interface GitignoreDiff {
  added_lines: number;
  removed_lines: number;
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
const AUTH_FILE_PATTERN = /\b(credentials|oauth|jwt|session-store|session-manager|auth-session|session-cookie)\b/i;

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

// v1.2.1 Bug 10 — default editor-backup + OS-noise patterns. Used when config.capture.classifier is absent.
const DEFAULT_BACKUP_PATTERNS = [
  "*.bak", "*.orig", "*.swp", "*.swo", "*~", ".#*",
  ".DS_Store", "Thumbs.db",
];

// v1.2.2 seed-rule constants
const LOCKFILE_MANIFEST_MAP: Record<string, string> = {
  "package-lock.json": "package.json",
  "yarn.lock": "package.json",
  "pnpm-lock.yaml": "package.json",
  "poetry.lock": "pyproject.toml",
  "Cargo.lock": "Cargo.toml",
  "Gemfile.lock": "Gemfile",
  "go.sum": "go.mod",
};

const IDE_CONFIG_PREFIXES: readonly string[] = [
  ".vscode/",
  ".idea/",
  ".fleet/",
  ".devcontainer/",
];
// NOTE: .github/ is intentionally excluded — it contains CI workflows which
// are classifiable material (not per-developer config).

function compileBackupPatterns(patterns: string[]): RegExp[] {
  const compiled: RegExp[] = [];
  const seenBad = new Set<string>();
  for (const pat of patterns) {
    try {
      const escaped = pat.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*");
      compiled.push(new RegExp(`^${escaped}$`));
    } catch {
      if (!seenBad.has(pat)) {
        console.error(`[context-ledger:classify] ignoring invalid editor_backup_pattern: ${pat}`);
        seenBad.add(pat);
      }
    }
  }
  return compiled;
}

function isEditorBackup(filepath: string, compiledPatterns: RegExp[]): boolean {
  const normalized = filepath.replace(/\\/g, "/");
  const filename = normalized.split("/").pop() ?? normalized;
  if (filename.length === 0) return false;
  for (const rx of compiledPatterns) if (rx.test(filename)) return true;
  return false;
}

// ── Seed Rules (v1.2.2) ──────────────────────────────────────────────────────
// Each predicate is whole-commit: returns shouldSuppress=true only if the
// ENTIRE changeset matches the rule's conditions. First match wins; reason is
// logged via console.error for the inbox diagnostic trail.

export interface SeedRuleOutcome {
  shouldSuppress: boolean;
  reason: string;
}

function isGitignoreTrivialCommit(
  meaningful: string[],
  gitignoreDiff: GitignoreDiff | null | undefined,
): SeedRuleOutcome {
  // Only fires when every meaningful file is .gitignore AND the diff is
  // a single-line add/remove. If gitignoreDiff is null/undefined (hook did
  // not bother to compute it), the rule does NOT suppress.
  const gitignoreOnly =
    meaningful.length > 0 &&
    meaningful.every((f) => {
      const parts = normLower(f).split("/");
      return parts[parts.length - 1] === ".gitignore";
    });
  if (!gitignoreOnly) {
    return { shouldSuppress: false, reason: "not gitignore-only" };
  }
  if (!gitignoreDiff) {
    return { shouldSuppress: false, reason: "gitignore diff not available" };
  }
  const totalLines = gitignoreDiff.added_lines + gitignoreDiff.removed_lines;
  if (totalLines !== 1) {
    return { shouldSuppress: false, reason: `gitignore multi-line (${totalLines} lines)` };
  }
  return { shouldSuppress: true, reason: "gitignore_trivial: single-line .gitignore change" };
}

function isIdeConfigOnlyCommit(meaningful: string[]): SeedRuleOutcome {
  if (meaningful.length === 0) {
    return { shouldSuppress: false, reason: "no files" };
  }
  const allIde = meaningful.every((f) => {
    const n = normLower(f);
    return IDE_CONFIG_PREFIXES.some((p) => n.startsWith(p));
  });
  if (!allIde) {
    return { shouldSuppress: false, reason: "not IDE-config-only" };
  }
  return { shouldSuppress: true, reason: "ide_config_only: all files under per-developer IDE config dirs" };
}

function isLockfileOnlyCommit(meaningful: string[]): SeedRuleOutcome {
  if (meaningful.length === 0) {
    return { shouldSuppress: false, reason: "no files" };
  }

  // Compute { parentDir, basename } for every file.
  // v1.2.2 council C4: basename-only comparison is path-insensitive and
  // breaks on monorepos. Compare lockfiles to their MATCHING-DIRECTORY
  // manifests, not to any manifest anywhere in the changeset.
  type FileEntry = { dir: string; base: string };
  const entries: FileEntry[] = meaningful.map((f) => {
    const n = norm(f);
    const parts = n.split("/");
    return {
      base: parts[parts.length - 1],
      dir: parts.slice(0, -1).join("/"),
    };
  });

  // Every file must be a known lockfile (by basename).
  const allLockfiles = entries.every((e) => e.base in LOCKFILE_MANIFEST_MAP);
  if (!allLockfiles) {
    return { shouldSuppress: false, reason: "not lockfile-only" };
  }

  // For EACH lockfile, the MATCHING manifest in the SAME directory must be absent.
  // If any lockfile has its sibling manifest in the changeset, do NOT suppress —
  // that's a dependency-change commit, handled by the existing Tier 1 detector.
  const byPath = new Set(entries.map((e) => (e.dir ? `${e.dir}/${e.base}` : e.base)));
  for (const entry of entries) {
    const manifestBase = LOCKFILE_MANIFEST_MAP[entry.base];
    const manifestPath = entry.dir ? `${entry.dir}/${manifestBase}` : manifestBase;
    if (byPath.has(manifestPath)) {
      return { shouldSuppress: false, reason: `manifest present in same directory — dependency change for ${entry.dir || "root"}` };
    }
  }
  return { shouldSuppress: true, reason: "lockfile_only: lockfiles without matching-directory manifests" };
}

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
  gitignoreDiff?: GitignoreDiff | null,
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

  // v1.2.2 seed rules — whole-commit suppressions. Evaluated in declared
  // order: gitignore_trivial → ide_config_only → lockfile_only. First match
  // wins; classifier returns [] to signal "not actionable, do not inbox".
  const seedRules = config.capture.classifier?.seed_rules;
  if (seedRules?.gitignore_trivial ?? true) {
    const outcome = isGitignoreTrivialCommit(meaningful, gitignoreDiff);
    if (outcome.shouldSuppress) {
      console.error(`[context-ledger:classify] suppressed: ${outcome.reason}`);
      return [];
    }
  }
  if (seedRules?.ide_config_only ?? true) {
    const outcome = isIdeConfigOnlyCommit(meaningful);
    if (outcome.shouldSuppress) {
      console.error(`[context-ledger:classify] suppressed: ${outcome.reason}`);
      return [];
    }
  }
  if (seedRules?.lockfile_only ?? true) {
    const outcome = isLockfileOnlyCommit(meaningful);
    if (outcome.shouldSuppress) {
      console.error(`[context-ledger:classify] suppressed: ${outcome.reason}`);
      return [];
    }
  }

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

  // File deletion (non-test, non-doc, non-editor-backup, not already caught by Tier 2)
  const backupPatterns = compileBackupPatterns(
    config.capture.classifier?.editor_backup_patterns ?? DEFAULT_BACKUP_PATTERNS,
  );
  const unclaimed = del.filter(
    (f) =>
      !claimedFiles.has(f) &&
      !isTestFile(f) &&
      !isDocFile(f) &&
      !isEditorBackup(f, backupPatterns),
  );
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

  // API route changes (Next.js app/api, pages/api, generic src/routes)
  const apiRouteFiles = all.filter((f) => {
    const n = normLower(f);
    return ROUTE_PATTERN.test(n) && !claimedFiles.has(f);
  });
  if (apiRouteFiles.length > 0) {
    results.push({
      tier: 1,
      change_category: "api-route-change",
      inbox_type: "draft_needed",
      changed_files: dedup(apiRouteFiles),
    });
    apiRouteFiles.forEach((f) => claimedFiles.add(f));
  }

  // Page route changes (Next.js App Router page.tsx / Pages Router page.tsx)
  const pageRouteFiles = all.filter((f) => {
    const n = normLower(f);
    return /page\.(tsx?|jsx?)$/.test(n) && !claimedFiles.has(f);
  });
  if (pageRouteFiles.length > 0) {
    results.push({
      tier: 1,
      change_category: "page-route-change",
      inbox_type: "draft_needed",
      changed_files: dedup(pageRouteFiles),
    });
    pageRouteFiles.forEach((f) => claimedFiles.add(f));
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
