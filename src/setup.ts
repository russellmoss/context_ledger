#!/usr/bin/env node
// context-ledger — interactive setup wizard

import { readFile, writeFile, readdir, access, mkdir } from "node:fs/promises";
import { join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import {
  intro, outro, cancel, note, log,
  confirm, multiselect, spinner, isCancel,
} from "@clack/prompts";
import { loadConfig } from "./config.js";
import type { ScopeMapping } from "./config.js";
import type { ScopeType } from "./ledger/index.js";
import { ledgerDir, configPath } from "./ledger/index.js";
import { queryDecisions } from "./retrieval/index.js";
import { detectHookSystem } from "./capture/detect-hooks.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Normalize a path to POSIX forward slashes with trailing slash (for config keys). */
function toPosixKey(p: string): string {
  const normalized = p.split("\\").join("/");
  return normalized.endsWith("/") ? normalized : normalized + "/";
}

/** Check isCancel and exit gracefully. Use after every @clack/prompts call. */
function guardCancel<T>(value: T | symbol): T {
  if (isCancel(value)) {
    cancel("Setup cancelled.");
    process.exit(0);
  }
  return value;
}

/** Check if a path exists. */
async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

// ── Standing Instructions Snippet ────────────────────────────────────────────

const STANDING_INSTRUCTIONS = `## context-ledger Integration

At session start (for non-/auto-feature sessions):
- Check inbox.jsonl for pending items (max 3 per session). Present Tier 2 (must-ask) first.
- Note: /auto-feature handles inbox checks automatically as its first step.

Before modifying architectural patterns, adding/removing dependencies, creating new directories,
or changing established conventions:
- Use query_decisions with the relevant file path (primary) or scope
- If a trusted precedent exists (retrieval_weight >= 0.7, durability = precedent, status = active),
  follow it and cite the decision ID
- If no precedent exists and the choice is ambiguous, flag it as a Bucket 2 question
- If diverging from a precedent, use supersede_decision with rationale and pain_points

After answering Phase 4 Bucket 2 questions:
- Classify each answer as precedent, feature-local, or temporary-workaround
- Use record_writeback for precedent-worthy answers only
- Temporary workarounds require a review_after date

For all MCP write tool calls, generate \`client_operation_id\` using the pattern:
\`{feature-slug}-{YYYYMMDD}-{random4chars}\` (e.g., \`sqo-export-20260401-a3f2\`).
Never reuse operation IDs across calls.`;

const STANDING_INSTRUCTIONS_MARKER = "## context-ledger Integration";

// ── Hook Script Template ─────────────────────────────────────────────────────

const HOOK_SCRIPT = `#!/bin/sh
# context-ledger post-commit hook
# Instantaneous, deterministic — zero LLM calls, zero network calls.
node -e "import('@mossrussell/context-ledger/dist/capture/hook.js').then(m => m.postCommit()).catch(() => {})" 2>/dev/null || true
`;

const HOOK_MARKER = "context-ledger";

// ── Main Wizard ──────────────────────────────────────────────────────────────

export async function runSetupWizard(projectRoot: string): Promise<void> {
  intro("context-ledger setup");

  let scopeMappingsWritten = false;
  let scopeCount = 0;
  let hookInstalled = false;
  let instructionsInjected = false;

  // ── Step 1: Project Detection ────────────────────────────────────────────
  try {
    log.step("Step 1: Project Detection");

    let projectName = "unknown";
    let techStack: string[] = [];

    try {
      const pkg = JSON.parse(await readFile(join(projectRoot, "package.json"), "utf8"));
      projectName = pkg.name ?? "unknown";
      const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
      if (allDeps["next"]) techStack.push("Next.js");
      if (allDeps["react"]) techStack.push("React");
      if (allDeps["express"]) techStack.push("Express");
      if (allDeps["fastify"]) techStack.push("Fastify");
      if (allDeps["typescript"]) techStack.push("TypeScript");
      if (allDeps["vue"]) techStack.push("Vue");
      if (allDeps["svelte"]) techStack.push("Svelte");
      if (allDeps["angular"]) techStack.push("Angular");
    } catch {
      log.warn("Could not read package.json");
    }

    const hasClaudeDir = await exists(join(projectRoot, ".claude"));
    const hasAgentGuard = await exists(join(projectRoot, "agent-docs.config.json"));

    let hasCouncilMcp = false;
    try {
      const settings = await readFile(join(projectRoot, ".claude", "settings.local.json"), "utf8");
      hasCouncilMcp = settings.includes("council");
    } catch { /* not found */ }

    const stackLabel = techStack.length > 0 ? techStack.join(", ") : "not detected";
    const lines = [
      `${hasClaudeDir ? "\u2713" : "\u2717"} .claude/ directory`,
      `${hasAgentGuard ? "\u2713" : "\u2717"} agent-guard`,
      `${hasCouncilMcp ? "\u2713" : "\u2717"} council-mcp`,
    ];
    note(
      `Project: ${projectName} (${stackLabel})\n\n${lines.join("\n")}`,
      "Project Summary",
    );
  } catch (err) {
    log.error(`Step 1 failed: ${err instanceof Error ? err.message : String(err)}`);
    log.info("Continuing to next step...");
  }

  // ── Step 2: Scope Mapping Generation ─────────────────────────────────────
  try {
    log.step("Step 2: Scope Mapping Generation");

    // Find source directory
    let sourceDir: string | null = null;
    for (const candidate of ["src", "app", "lib"]) {
      if (await exists(join(projectRoot, candidate))) {
        sourceDir = candidate;
        break;
      }
    }

    if (!sourceDir) {
      log.warn("No source directory found (tried src/, app/, lib/). Skipping scope mapping generation.");
    } else {
      // Scan 2 levels deep
      interface ScopeSuggestion {
        path: string;
        type: ScopeType;
        id: string;
      }
      const suggestions: ScopeSuggestion[] = [];
      const concernNames = new Set(["lib", "utils", "helpers", "shared", "common"]);

      const topLevel = await readdir(join(projectRoot, sourceDir), { withFileTypes: true });
      for (const entry of topLevel) {
        if (!entry.isDirectory()) continue;
        const dirName = entry.name;
        const relPath = toPosixKey(`${sourceDir}/${dirName}`);
        const scopeType: ScopeType = concernNames.has(dirName) ? "concern" : "domain";
        suggestions.push({ path: relPath, type: scopeType, id: dirName });

        // Second level
        try {
          const secondLevel = await readdir(join(projectRoot, sourceDir, dirName), { withFileTypes: true });
          for (const sub of secondLevel) {
            if (!sub.isDirectory()) continue;
            const subRelPath = toPosixKey(`${sourceDir}/${dirName}/${sub.name}`);
            const subType: ScopeType = concernNames.has(sub.name) ? "concern" : "domain";
            suggestions.push({ path: subRelPath, type: subType, id: sub.name });
          }
        } catch { /* can't read subdirectory */ }
      }

      // Sort alphabetically
      suggestions.sort((a, b) => a.path.localeCompare(b.path));

      if (suggestions.length === 0) {
        log.info("No directories found for scope mapping.");
      } else {
        const selectedMappings = guardCancel(await multiselect({
          message: "Which scope mappings should be created?",
          options: suggestions.map(s => ({
            value: s.path,
            label: `${s.path} \u2192 ${s.type}/${s.id}`,
          })),
          initialValues: suggestions.map(s => s.path),
          required: false,
        })) as string[];

        if (selectedMappings.length > 0) {
          // Deep-clone config before mutating (C2 fix — loadConfig returns shared DEFAULT_CONFIG on ENOENT)
          const config = structuredClone(await loadConfig(projectRoot));

          // Additive merge — never overwrite existing keys (S11)
          const newHintMappings: Record<string, string[]> = {};
          for (const path of selectedMappings) {
            const suggestion = suggestions.find(s => s.path === path);
            if (suggestion && !(suggestion.path in config.capture.scope_mappings)) {
              config.capture.scope_mappings[suggestion.path] = {
                type: suggestion.type,
                id: suggestion.id,
              };
            }
            // Build feature hint mappings from basenames
            if (suggestion) {
              const keyword = suggestion.id;
              if (!(keyword in config.retrieval.feature_hint_mappings) && !(keyword in newHintMappings)) {
                newHintMappings[keyword] = [suggestion.id];
              }
            }
          }

          for (const [keyword, scopeIds] of Object.entries(newHintMappings)) {
            if (!(keyword in config.retrieval.feature_hint_mappings)) {
              config.retrieval.feature_hint_mappings[keyword] = scopeIds;
            }
          }

          // Ensure directory exists, then write config
          await mkdir(ledgerDir(projectRoot), { recursive: true });
          await writeFile(configPath(projectRoot), JSON.stringify(config, null, 2) + "\n", "utf8");

          scopeCount = selectedMappings.length;
          scopeMappingsWritten = true;
          log.success(`Wrote ${scopeCount} scope mapping(s) to config.json`);
        }
      }
    }
  } catch (err) {
    log.error(`Step 2 failed: ${err instanceof Error ? err.message : String(err)}`);
    log.info("Continuing to next step...");
  }

  // ── Step 3: Hook Installation ────────────────────────────────────────────
  try {
    log.step("Step 3: Hook Installation");

    // Check for .git directory first (S10)
    if (!(await exists(join(projectRoot, ".git")))) {
      log.warn("No git repository found. Run 'git init' first, then re-run setup to install hooks.");
    } else {
      const hookResult = await detectHookSystem(projectRoot);
      log.info(`Detected hook system: ${hookResult.system}`);

      if (hookResult.alreadyInstalled) {
        log.success("Post-commit hook already installed.");
        hookInstalled = true;
      } else if (hookResult.system === "husky" || hookResult.system === "bare") {
        const proceed = guardCancel(await confirm({
          message: `Install post-commit hook via ${hookResult.system === "husky" ? "Husky" : ".git/hooks/"}?`,
        }));

        if (proceed) {
          const hookPath = hookResult.hookPath!;
          let content: string | null = null;
          try {
            content = await readFile(hookPath, "utf8");
          } catch { /* file doesn't exist yet */ }

          if (content && content.includes(HOOK_MARKER)) {
            log.success("Hook already installed.");
            hookInstalled = true;
          } else if (content) {
            await writeFile(hookPath, content.trimEnd() + "\n\n" + HOOK_SCRIPT, { mode: 0o755 });
            log.success("Appended context-ledger to existing post-commit hook.");
            hookInstalled = true;
          } else {
            await writeFile(hookPath, HOOK_SCRIPT, { mode: 0o755 });
            log.success("Installed post-commit hook.");
            hookInstalled = true;
          }
        }
      } else if (hookResult.system === "lefthook") {
        note(
          `Add the following to your lefthook.yml:\n\n` +
          `post-commit:\n` +
          `  commands:\n` +
          `    context-ledger:\n` +
          `      run: node -e "import('@mossrussell/context-ledger/dist/capture/hook.js').then(m => m.postCommit()).catch(() => {})"`,
          "Lefthook Configuration",
        );
      } else if (hookResult.system === "simple-git-hooks") {
        note(
          `Add to your package.json:\n\n` +
          `"simple-git-hooks": {\n` +
          `  "post-commit": "node -e \\"import('@mossrussell/context-ledger/dist/capture/hook.js').then(m => m.postCommit()).catch(() => {})\\""` +
          `\n}`,
          "simple-git-hooks Configuration",
        );
      } else {
        log.warn("Could not detect a hook system. Install one (Husky, Lefthook) or ensure .git/hooks/ exists.");
      }
    }
  } catch (err) {
    log.error(`Step 3 failed: ${err instanceof Error ? err.message : String(err)}`);
    log.info("Continuing to next step...");
  }

  // ── Step 4: Standing Instructions Injection ──────────────────────────────
  try {
    log.step("Step 4: Standing Instructions Injection");

    const claudeMdPath = join(projectRoot, "CLAUDE.md");
    const cursorrulesPath = join(projectRoot, ".cursorrules");
    let targetPath: string | null = null;

    // Detect target file (S3 resolved: CLAUDE.md only)
    const claudeMdExists = await exists(claudeMdPath);
    const cursorrulesExists = await exists(cursorrulesPath);

    if (claudeMdExists) {
      targetPath = claudeMdPath;
      if (cursorrulesExists) {
        log.info("Found both CLAUDE.md and .cursorrules \u2014 using CLAUDE.md as primary target.");
      }
    } else if (cursorrulesExists) {
      targetPath = cursorrulesPath;
    }

    if (!targetPath) {
      // Neither exists — offer to create CLAUDE.md (S2)
      const createIt = guardCancel(await confirm({
        message: "No CLAUDE.md or .cursorrules found. Create CLAUDE.md with context-ledger instructions?",
      }));
      if (createIt) {
        await writeFile(claudeMdPath, STANDING_INSTRUCTIONS + "\n", "utf8");
        instructionsInjected = true;
        log.success("Created CLAUDE.md with standing instructions.");
      }
    } else {
      // Read existing file
      const existing = await readFile(targetPath, "utf8");

      // Check idempotency marker (S4)
      if (existing.includes(STANDING_INSTRUCTIONS_MARKER)) {
        log.success("Standing instructions already present.");
      } else {
        // Show snippet and ask for confirmation
        note(STANDING_INSTRUCTIONS, "Standing instructions to inject");
        const proceed = guardCancel(await confirm({
          message: `Add to ${basename(targetPath)}?`,
        }));

        if (proceed) {
          let updated: string;

          // Agent-guard block detection (S8)
          const agentGuardMatch = existing.match(/^##?\s+.*agent-guard.*/im);
          if (agentGuardMatch) {
            const agentGuardPos = existing.indexOf(agentGuardMatch[0]);
            const afterAgentGuard = existing.slice(agentGuardPos + agentGuardMatch[0].length);
            const nextHeadingMatch = afterAgentGuard.match(/\n##?\s+/m);
            if (nextHeadingMatch) {
              const insertPos = agentGuardPos + agentGuardMatch[0].length + nextHeadingMatch.index!;
              updated = existing.slice(0, insertPos) + "\n\n" + STANDING_INSTRUCTIONS + "\n" + existing.slice(insertPos);
            } else {
              updated = existing.trimEnd() + "\n\n" + STANDING_INSTRUCTIONS + "\n";
            }
          } else {
            updated = existing.trimEnd() + "\n\n" + STANDING_INSTRUCTIONS + "\n";
          }

          await writeFile(targetPath, updated, "utf8");
          instructionsInjected = true;
          log.success(`Injected standing instructions into ${basename(targetPath)}.`);
        }
      }
    }
  } catch (err) {
    log.error(`Step 4 failed: ${err instanceof Error ? err.message : String(err)}`);
    log.info("Continuing to next step...");
  }

  // ── Step 5: First-Run Demo ───────────────────────────────────────────────
  try {
    log.step("Step 5: First-Run Demo");

    const s = spinner();
    s.start("Querying decisions...");

    try {
      const pack = await queryDecisions({ query: "architecture" }, projectRoot);
      s.stop("Query complete.");

      if (pack.active_precedents.length > 0) {
        const lines = [
          `Active Precedents: ${pack.active_precedents.length}`,
          ...pack.active_precedents.slice(0, 5).map(p =>
            `  \u2022 [${p.record.id}] ${p.record.summary} (weight: ${p.retrieval_weight})`
          ),
          `Abandoned Approaches: ${pack.abandoned_approaches.length}`,
          `Pending Inbox Items: ${pack.pending_inbox_items.length}`,
          `Token Estimate: ${pack.token_estimate.toLocaleString()}`,
        ];
        note(lines.join("\n"), "Decision Pack Preview");
      } else {
        note(
          `Your ledger is empty \u2014 no decisions captured yet.\n\n` +
          `After your first few commits with the post-commit hook,\n` +
          `or after running 'context-ledger backfill', the decision\n` +
          `pack will start populating.\n\n` +
          `Example decision pack:\n` +
          `  Active Precedents: 3\n` +
          `  \u2022 Use COALESCE for null handling (weight: 0.9)\n` +
          `  \u2022 Prefer server components (weight: 0.85)\n` +
          `  Abandoned Approaches: 1\n` +
          `  Token Estimate: ~2,000`,
          "What Claude Code will see",
        );
      }
    } catch {
      s.stop("No ledger found.");
      note(
        "Your ledger is empty \u2014 decisions will appear after your first commits.",
        "First-Run Demo",
      );
    }
  } catch (err) {
    log.error(`Step 5 failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // ── Outro ────────────────────────────────────────────────────────────────

  const steps: string[] = [];
  if (scopeMappingsWritten) steps.push(`${scopeCount} scope mapping(s) configured`);
  if (hookInstalled) steps.push("Post-commit hook installed");
  if (instructionsInjected) steps.push("Standing instructions added");

  outro(
    `Setup complete!\n\n` +
    (steps.length > 0 ? steps.map(s => `  \u2713 ${s}`).join("\n") + "\n\n" : "") +
    `Next steps:\n` +
    `  \u2022 Run 'context-ledger backfill' to capture history from recent commits\n` +
    `  \u2022 Start making commits \u2014 the hook will capture decisions automatically\n` +
    `  \u2022 Use 'context-ledger query <topic>' to test retrieval`,
  );
}

// ── Self-invocation (direct-run as context-ledger-setup binary) ──────────

const isDirectRun = process.argv[1] === fileURLToPath(import.meta.url);
if (isDirectRun) {
  const projectRoot = process.env.CONTEXT_LEDGER_PROJECT_ROOT ?? process.cwd();
  runSetupWizard(projectRoot).catch((err) => {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  });
}
