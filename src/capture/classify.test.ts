// context-ledger — classify.ts unit tests (Bug 10: editor-backup suppression)
// Standalone script: exit 0 on pass, 1 on fail.

import { classifyCommit } from "./classify.js";
import type { LedgerConfig } from "../config.js";
import { DEFAULT_CONFIG } from "../config.js";

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

async function main(): Promise<void> {
  await test1BackupOnlySuppressed();
  await test2MixedDeletionKeepsReal();
  await test3GitignoreAndBackupsSuppressed();
  await test4CustomPatterns();
  await test5WindowsPaths();
  await test6DotfileNotMatchedByHashStar();

  console.error(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
