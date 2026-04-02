// context-ledger — shared hook system detection

import { readFile, access } from "node:fs/promises";
import { join } from "node:path";

export type HookSystem = "husky" | "lefthook" | "simple-git-hooks" | "bare" | "none";

export interface HookDetectionResult {
  system: HookSystem;
  /** Path to the hook file (for husky and bare) or config file (for lefthook). */
  hookPath: string | null;
  /** Whether the context-ledger hook is already installed. */
  alreadyInstalled: boolean;
}

const MARKER = "context-ledger";

export async function detectHookSystem(projectRoot: string): Promise<HookDetectionResult> {
  // 1. Husky
  const huskyDir = join(projectRoot, ".husky");
  try {
    await access(huskyDir);
    const hookPath = join(huskyDir, "post-commit");
    const installed = await checkMarker(hookPath);
    return { system: "husky", hookPath, alreadyInstalled: installed };
  } catch { /* not husky */ }

  // 2. Lefthook
  const lefthookPath = join(projectRoot, "lefthook.yml");
  try {
    await access(lefthookPath);
    return { system: "lefthook", hookPath: lefthookPath, alreadyInstalled: false };
  } catch { /* not lefthook */ }

  // 3. simple-git-hooks
  try {
    const pkg = JSON.parse(await readFile(join(projectRoot, "package.json"), "utf8"));
    if (pkg["simple-git-hooks"]) {
      return { system: "simple-git-hooks", hookPath: null, alreadyInstalled: false };
    }
  } catch { /* ignore */ }

  // 4. Bare .git/hooks/
  const bareHookDir = join(projectRoot, ".git", "hooks");
  try {
    await access(bareHookDir);
    const hookPath = join(bareHookDir, "post-commit");
    const installed = await checkMarker(hookPath);
    return { system: "bare", hookPath, alreadyInstalled: installed };
  } catch { /* no .git/hooks */ }

  return { system: "none", hookPath: null, alreadyInstalled: false };
}

async function checkMarker(hookPath: string): Promise<boolean> {
  try {
    const content = await readFile(hookPath, "utf8");
    return content.includes(MARKER);
  } catch {
    return false; // file doesn't exist yet
  }
}
