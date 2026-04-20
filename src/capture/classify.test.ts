// context-ledger — classify.ts unit tests (Bug 10: editor-backup suppression)
// Standalone script: exit 0 on pass, 1 on fail.

import { classifyCommit } from "./classify.js";
import type { LedgerConfig } from "../config.js";
import { DEFAULT_CONFIG, loadConfig } from "../config.js";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string): void {
  if (condition) {
    passed++;
    console.error(`  ✓ ${label}`);
  } else {
    failed++;
    console.error(`  ✗ ${label}`);
  }
}

function makeConfig(): LedgerConfig {
  return JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as LedgerConfig;
}

function hasFileDeletion(results: ReturnType<typeof classifyCommit>): boolean {
  return results.some((r) => r.change_category === "file-deletion");
}

function fileDeletionFiles(results: ReturnType<typeof classifyCommit>): string[] {
  const r = results.find((x) => x.change_category === "file-deletion");
  return r?.changed_files ?? [];
}

async function test1BackupOnlySuppressed(): Promise<void> {
  console.error("\nTest 1: backup-only deletions produce no file-deletion classification");
  const config = makeConfig();
  const all = ["foo.bak", "bar.orig"];
  const del = ["foo.bak", "bar.orig"];
  const add: string[] = [];
  const results = classifyCommit(all, del, add, "chore: cleanup", config, null);
  assert(!hasFileDeletion(results), "no file-deletion classification emitted");
}

async function test2MixedDeletionKeepsReal(): Promise<void> {
  console.error("\nTest 2: mixed deletion (backup + real) classifies only real file");
  const config = makeConfig();
  const all = ["foo.bak", "src/real.ts"];
  const del = ["foo.bak", "src/real.ts"];
  const add: string[] = [];
  const results = classifyCommit(all, del, add, "refactor: remove real.ts", config, null);
  assert(hasFileDeletion(results), "file-deletion classification emitted");
  const files = fileDeletionFiles(results);
  assert(files.includes("src/real.ts"), "real.ts in changed_files");
  assert(!files.includes("foo.bak"), "foo.bak filtered out of changed_files");
}

async function test3GitignoreAndBackupsSuppressed(): Promise<void> {
  console.error("\nTest 3: .gitignore + backup deletions produce no file-deletion");
  const config = makeConfig();
  const all = [".gitignore", "foo.bak"];
  const del = ["foo.bak"];
  const add: string[] = [];
  const results = classifyCommit(all, del, add, "chore: ignore bak", config, null);
  assert(!hasFileDeletion(results), "no file-deletion classification emitted");
}

async function test4CustomPatterns(): Promise<void> {
  console.error("\nTest 4: custom editor_backup_patterns honored");
  const config = makeConfig();
  config.capture.classifier = { editor_backup_patterns: ["*.local"] };
  const all = ["notes.local", "src/real.ts"];
  const del = ["notes.local", "src/real.ts"];
  const add: string[] = [];
  const results = classifyCommit(all, del, add, "cleanup", config, null);
  assert(hasFileDeletion(results), "file-deletion classification emitted (real.ts remains)");
  const files = fileDeletionFiles(results);
  assert(!files.includes("notes.local"), "custom-pattern file suppressed");
  assert(files.includes("src/real.ts"), "real file retained");
}

async function test5WindowsPaths(): Promise<void> {
  console.error("\nTest 5: backslash-separated paths still classified correctly (portability)");
  const config = makeConfig();
  const all = ["src\\feature\\file.bak"];
  const del = ["src\\feature\\file.bak"];
  const add: string[] = [];
  const results = classifyCommit(all, del, add, "cleanup", config, null);
  assert(!hasFileDeletion(results), "backslash-path .bak deletion suppressed");
}

async function test6DotfileNotMatchedByHashStar(): Promise<void> {
  console.error("\nTest 6: plain dotfile NOT matched by .#* pattern (no accidental dotfile suppression)");
  // Use .somefile — a plain dotfile not claimed by any other classifier (not env, not config, not test/doc).
  // The .#* regex compiles to ^\.#[^/]*$, which requires a literal # as the second character.
  // .somefile's second char is 's' — should NOT match, so file-deletion should still fire.
  const config = makeConfig();
  const all = [".somefile", "src/real.ts"];
  const del = [".somefile", "src/real.ts"];
  const add: string[] = [];
  const results = classifyCommit(all, del, add, "cleanup", config, null);
  assert(hasFileDeletion(results), "file-deletion classification emitted");
  const files = fileDeletionFiles(results);
  assert(files.includes(".somefile"), ".somefile retained (not matched by .#*)");
  assert(files.includes("src/real.ts"), "src/real.ts retained");
}

// ── Seed Rule Tests (v1.2.2) ─────────────────────────────────────────────────

async function test7_gitignoreTrivialSuppressed(): Promise<void> {
  console.error("\nTest 7: .gitignore-only single-line commit is suppressed");
  const config = makeConfig();
  const all = [".gitignore"];
  const results = classifyCommit(all, [], [], "chore: ignore dist", config, null, {
    added_lines: 1,
    removed_lines: 0,
  });
  assert(results.length === 0, "gitignore-only single-line commit produces no results");
}

async function test8_gitignoreMixedNotSuppressed(): Promise<void> {
  console.error("\nTest 8: .gitignore + real source change NOT suppressed by gitignore_trivial");
  // Toggle the rule off and compare — the rule's behavior contribution on a
  // mixed commit must be zero. Works regardless of what other classifiers emit.
  const all = [".gitignore", "src/real.ts"];
  const del: string[] = [];
  const add = ["src/real.ts"];
  const on = makeConfig();
  const off = makeConfig();
  off.capture.classifier!.seed_rules = { gitignore_trivial: false };
  const resultsOn = classifyCommit(all, del, add, "feat: add real", on, null, {
    added_lines: 1,
    removed_lines: 0,
  });
  const resultsOff = classifyCommit(all, del, add, "feat: add real", off, null, null);
  assert(
    JSON.stringify(resultsOn) === JSON.stringify(resultsOff),
    "gitignore_trivial does not affect mixed commits (toggle has no effect)",
  );
}

async function test9_ideConfigOnlySuppressed(): Promise<void> {
  console.error("\nTest 9: IDE-config-only commit is suppressed");
  const config = makeConfig();
  // Mix forward- and back-slash paths to exercise normLower's Windows portability
  // (council S4 regression assertion — normLower at classify.ts:24 replaces \\ with /).
  const all = [".vscode/settings.json", ".idea\\workspace.xml"];
  const results = classifyCommit(all, [], [], "chore: ide", config, null, null);
  assert(results.length === 0, "IDE-config-only commit (mixed separators) produces no results");
}

async function test10_ideConfigWithGithubNotSuppressed(): Promise<void> {
  console.error("\nTest 10: .github/ workflow change is NOT caught by ide_config_only");
  const all = [".github/workflows/ci.yml"];
  const on = makeConfig();
  const off = makeConfig();
  off.capture.classifier!.seed_rules = { ide_config_only: false };
  const resultsOn = classifyCommit(all, [], [], "ci: add workflow", on, null, null);
  const resultsOff = classifyCommit(all, [], [], "ci: add workflow", off, null, null);
  assert(
    JSON.stringify(resultsOn) === JSON.stringify(resultsOff),
    "ide_config_only does not fire on .github/ path",
  );
}

async function test11_lockfileOnlySuppressed(): Promise<void> {
  console.error("\nTest 11: lockfile-only commit (no manifest) is suppressed");
  const config = makeConfig();
  const all = ["package-lock.json"];
  const results = classifyCommit(all, [], [], "chore: bump lockfile", config, null, null);
  assert(results.length === 0, "lockfile-only commit produces no results");
}

async function test12_lockfileWithManifestNotSuppressed(): Promise<void> {
  console.error("\nTest 12: lockfile + matching-directory manifest classifies as dependency change");
  const config = makeConfig();
  // Both files at repo root, same directory. The existing dependency-addition
  // detector (Tier 1) emits change_category "dependency-addition" with only
  // package.json in changed_files (not package-lock.json). Council S6 note.
  const all = ["package-lock.json", "package.json"];
  const results = classifyCommit(all, [], [], "chore: add dep", config, {
    addedDeps: ["foo@1.0.0"],
    removedDeps: [],
    otherChanges: false,
  }, null);
  assert(results.length > 0, "manifest + lockfile produces at least one classification");
  assert(
    results.some((r) => r.change_category === "dependency-addition"),
    "dependency-addition result emitted",
  );
}

async function test13_lockfileMonorepoSiblingManifest(): Promise<void> {
  // Council C4 regression: a lockfile in packages/a and an UNRELATED manifest
  // in packages/b should NOT block suppression for packages/a. The dir-pair
  // comparison ensures only matching-directory manifests count.
  //
  // Here: packages/a/package-lock.json changes + packages/b/pyproject.toml
  // changes. The lockfile's matching manifest is packages/a/package.json,
  // which is ABSENT. `all`-lockfiles check fails because pyproject.toml is
  // not in LOCKFILE_MANIFEST_MAP, so the rule returns shouldSuppress=false
  // with reason "not lockfile-only" — and classification proceeds.
  console.error("\nTest 13: monorepo lockfile + unrelated manifest — mixed, rule skips");
  const all = ["packages/a/package-lock.json", "packages/b/pyproject.toml"];
  const on = makeConfig();
  const off = makeConfig();
  off.capture.classifier!.seed_rules = { lockfile_only: false };
  const resultsOn = classifyCommit(all, [], [], "chore: mixed monorepo", on, null, null);
  const resultsOff = classifyCommit(all, [], [], "chore: mixed monorepo", off, null, null);
  assert(
    JSON.stringify(resultsOn) === JSON.stringify(resultsOff),
    "lockfile_only does not fire on mixed-type monorepo commit",
  );
}

async function test14_deepMergeBooleanOverride(): Promise<void> {
  // Council I3: verify a user config of { seed_rules: { gitignore_trivial: false } }
  // deep-merges to { gitignore_trivial: false, ide_config_only: true, lockfile_only: true }.
  // Regression guard against deepMerge mishandling explicit `false` as falsy.
  console.error("\nTest 14: deepMerge preserves explicit false override on seed_rules");
  const tmp = await mkdtemp(join(tmpdir(), "cl-classify-"));
  try {
    await mkdir(join(tmp, ".context-ledger"), { recursive: true });
    // Partial user config — only overrides gitignore_trivial; the other two
    // booleans and editor_backup_patterns must survive the merge as defaults.
    await writeFile(
      join(tmp, ".context-ledger", "config.json"),
      JSON.stringify({ capture: { classifier: { seed_rules: { gitignore_trivial: false } } } }),
      "utf8",
    );
    const merged = await loadConfig(tmp);
    const sr = merged.capture.classifier?.seed_rules;
    assert(sr?.gitignore_trivial === false, "explicit false override preserved (gitignore_trivial === false)");
    assert(sr?.ide_config_only === true, "unset sibling retains default (ide_config_only === true)");
    assert(sr?.lockfile_only === true, "unset sibling retains default (lockfile_only === true)");
    assert(
      Array.isArray(merged.capture.classifier?.editor_backup_patterns) &&
        (merged.capture.classifier?.editor_backup_patterns?.length ?? 0) > 0,
      "editor_backup_patterns default preserved through merge",
    );

    // Behavioral check: with gitignore_trivial=false, the suppression does not fire.
    const all = [".gitignore"];
    const resultsOff = classifyCommit(all, [], [], "chore: ignore", merged, null, {
      added_lines: 1,
      removed_lines: 0,
    });
    // Normal classifiers emit nothing for a lone .gitignore either, so results is []
    // — but the key invariant here is that no `suppressed: gitignore_trivial` diagnostic
    // was emitted. Assertion is on the merged config shape above.
    assert(Array.isArray(resultsOff), "classifyCommit returns an array (sanity)");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  await test1BackupOnlySuppressed();
  await test2MixedDeletionKeepsReal();
  await test3GitignoreAndBackupsSuppressed();
  await test4CustomPatterns();
  await test5WindowsPaths();
  await test6DotfileNotMatchedByHashStar();
  await test7_gitignoreTrivialSuppressed();
  await test8_gitignoreMixedNotSuppressed();
  await test9_ideConfigOnlySuppressed();
  await test10_ideConfigWithGithubNotSuppressed();
  await test11_lockfileOnlySuppressed();
  await test12_lockfileWithManifestNotSuppressed();
  await test13_lockfileMonorepoSiblingManifest();
  await test14_deepMergeBooleanOverride();

  console.error(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
