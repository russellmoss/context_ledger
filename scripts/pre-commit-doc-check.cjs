'use strict';
/**
 * pre-commit-doc-check.js
 * Pre-commit hook: detects doc-relevant code changes and generates a Claude Code prompt.
 * Called by .husky/pre-commit.
 *
 * Config-driven: reads categories, docsDir, agentConfigFile, and architectureFile
 * from agent-docs.config.json
 *
 * Behavior:
 *   - Warns (stderr) + generates prompt when doc-relevant code changed WITHOUT doc updates
 *   - Shows positive note when doc-relevant code changed WITH doc updates
 *   - Silent when no doc-relevant files changed
 *   - ALWAYS exits 0 — this is a reminder, never a gate
 *
 * Usage: node scripts/pre-commit-doc-check.js [--verbose]
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { loadConfig, PROJECT_ROOT } = require('./_config-reader.cjs');
const claudeEngine = require('./_claude-engine.cjs');
const { printAutoFixSummary, printPromptFallback } = require('./_terminal-output.cjs');
const { logEntry } = require('./_audit-log.cjs');

const verbose = process.argv.includes('--verbose');

// Outer-scope — set inside main(), read by .catch() handler
let effectiveBlockingMode = false;

// Deferred config/categories — loaded on first use (not at require time for testability)
let config = null;
let CATEGORIES = null;

function ensureConfig() {
  if (!config) {
    config = loadConfig();
    CATEGORIES = (config.categories || []).map(cat => ({
      id: cat.id,
      name: cat.name,
      emoji: cat.emoji || '📦',
      test: buildTestFunction(cat),
      docTarget: cat.docTarget
        ? `${cat.docTarget} in ${config.architectureFile || 'docs/ARCHITECTURE.md'}`
        : `Relevant section in ${config.architectureFile || 'docs/ARCHITECTURE.md'}`,
      genCommand: cat.genCommand || null,
    }));
  }
}

function stderr(msg) {
  process.stderr.write(msg);
}

// ── Build CATEGORIES dynamically from config ─────────────────────────────────

function buildTestFunction(cat) {
  switch (cat.patternType) {
    case 'exact':
      return (f) => f === cat.filePattern;
    case 'startsWith':
      return (f) => f.startsWith(cat.filePattern);
    case 'regex':
      return (f) => new RegExp(cat.filePattern).test(f);
    default:
      return (f) => f === cat.filePattern;
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Get list of staged file paths from git. Returns [] on any error. */
function getStagedFiles() {
  try {
    const out = execSync('git diff --cached --name-only', {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return out.trim().split('\n').filter(f => f.length > 0);
  } catch { /* git not available or not in repo */
    return [];
  }
}

/** Return true if a staged file is a documentation file. */
function isDocFile(f) {
  const docsDir = config.docsDir || 'docs/';
  const agentConfig = config.agentConfigFile || '.cursorrules';
  return f.startsWith(docsDir) || f === agentConfig;
}

// ── Categorize staged files ──────────────────────────────────────────────────

function categorize(stagedFiles) {
  const matches = {}; // categoryId → [filePaths]
  const unmatched = [];

  for (const file of stagedFiles) {
    let matched = false;
    for (const cat of CATEGORIES) {
      if (cat.test(file)) {
        if (!matches[cat.id]) matches[cat.id] = [];
        matches[cat.id].push(file);
        matched = true;
        break; // first match wins
      }
    }
    if (!matched) {
      unmatched.push(file);
    }
  }

  return { matches, unmatched };
}

// ── Build the Claude Code prompt ─────────────────────────────────────────────

function buildPrompt(matches) {
  const archFile = config.architectureFile || 'docs/ARCHITECTURE.md';
  const lines = [];
  lines.push('The following files were changed and documentation may need updating.');
  lines.push(`Read each changed file listed below, then update ${archFile} accordingly.`);
  lines.push('');

  // Group files by category and build instructions
  for (const cat of CATEGORIES) {
    if (!matches[cat.id]) continue;

    const files = matches[cat.id];
    lines.push(`Changed ${cat.name}:`);

    const show = files.slice(0, 15);
    for (const f of show) {
      lines.push(`- Read ${f} — update ${cat.docTarget}`);
    }
    if (files.length > 15) {
      lines.push(`  (and ${files.length - 15} more files)`);
    }
    lines.push('');
  }

  // Gen commands
  const genCommands = [];
  for (const cat of CATEGORIES) {
    if (matches[cat.id] && cat.genCommand && !genCommands.includes(cat.genCommand)) {
      genCommands.push(cat.genCommand);
    }
  }
  if (genCommands.length > 0) {
    lines.push(`After updating ${archFile}, run:`);
    for (const cmd of genCommands) {
      lines.push(cmd);
    }
    lines.push('');
  }

  lines.push('Rules:');
  lines.push('- Read each file BEFORE updating docs');
  lines.push(`- Match the existing format in ${archFile}`);
  lines.push('- Do NOT modify any source code files');

  return lines.join('\n');
}

/**
 * Build a prompt specifically for Claude Code narrative updates.
 * Targets only narrativeTargets files, not agent configs.
 */
function buildNarrativePrompt(matches, cfg) {
  const archFile = cfg.architectureFile || 'docs/ARCHITECTURE.md';
  const targets = [
    archFile,
    ...(cfg.autoFix?.narrative?.additionalNarrativeTargets || ['README.md']),
  ];

  const lines = [
    'The following code files were changed. Update the documentation to reflect these changes.',
    '',
    `Files you MUST update: ${targets.join(', ')}`,
    '',
  ];

  for (const cat of CATEGORIES) {
    if (!matches[cat.id]) continue;
    const files = matches[cat.id];
    lines.push(`Changed ${cat.name} (${files.length} file${files.length !== 1 ? 's' : ''}):`);
    const show = files.slice(0, 15);
    for (const f of show) {
      lines.push(`  - ${f}`);
    }
    if (files.length > 15) {
      lines.push(`  ... and ${files.length - 15} more`);
    }
    lines.push('');
  }

  lines.push('RULES:');
  lines.push('- Read each changed source file BEFORE updating docs');
  lines.push(`- Match the existing format and section structure in ${archFile}`);
  lines.push('- Do NOT modify any source code files');
  lines.push('- Do NOT modify .cursorrules, CLAUDE.md, or any agent config files');
  lines.push('- Do NOT create new files — only update existing ones');
  lines.push(`- Only update these files: ${targets.join(', ')}`);

  return lines.join('\n');
}

// ── Standing Instructions (CJS-compatible generator) ────────────────────────

/**
 * Lightweight CJS rebuild of standing instructions from config.
 * Mirrors src/generators/standing-instructions.js but runs inside the hook.
 */
function generateStandingInstructionsCJS(cfg) {
  const archFile = cfg.architectureFile || 'docs/ARCHITECTURE.md';

  const tableRows = [];
  for (const cat of cfg.categories || []) {
    const trigger = cat.filePattern;
    const update = cat.docTarget
      ? `${cat.docTarget} in \`${archFile}\``
      : `Relevant section in \`${archFile}\``;
    const command = cat.genCommand ? `Run \`${cat.genCommand}\`` : '—';

    let displayPattern;
    if (cat.patternType === 'regex') {
      displayPattern = `Files matching \`${trigger}\``;
    } else if (cat.patternType === 'startsWith') {
      displayPattern = `\`${trigger}*\``;
    } else {
      displayPattern = `\`${trigger}\``;
    }
    tableRows.push(`| ${displayPattern} | ${update} | ${command} |`);
  }

  const lines = [
    '## Documentation Maintenance — Standing Instructions',
    '',
    '### Rule: Update Docs When You Change Code',
    '',
    'When you add, rename, remove, or significantly modify any of the following, you MUST update the relevant documentation **in the same session** — do not defer to a later task:',
    '',
    '| If You Changed… | Update This | And Run… |',
    '|---|---|---|',
    ...tableRows,
    '',
    '### Generated Inventories',
    '',
    `Auto-generated inventory files exist at \`${cfg.generatedDir || 'docs/_generated/'}\`:`,
  ];

  const genCommands = (cfg.categories || [])
    .filter(c => c.genCommand)
    .map(c => `- \`${c.genCommand}\``);
  const uniqueCommands = [...new Set(genCommands)];
  lines.push(...uniqueCommands);
  lines.push('- Run all: `npm run gen:all`');
  lines.push('');
  lines.push('These are committed to the repo. Always regenerate after changing routes, models, or env vars.');
  lines.push('');
  lines.push('### Pre-Commit Hook Behavior');
  lines.push('- If the pre-commit hook is in **blocking mode** (`autoFix.hook.mode: "blocking"`), you MUST update documentation BEFORE committing. The hook will exit 1 and reject the commit if docs are stale. Run generators and update narrative docs first, then commit.');
  lines.push('- When you (an AI agent) trigger a commit, the hook detects this and skips all AI engines to prevent self-invocation. If docs are stale, the commit will be rejected with exit 1. Read the changed source files, update the relevant sections in docs/ARCHITECTURE.md (and any other doc targets) yourself, stage with git add, then retry the commit. Do NOT run npx agent-guard sync — update the files yourself directly.');
  lines.push('');
  lines.push('### What NOT to Do');
  lines.push(`- Do NOT edit files in \`${cfg.generatedDir || 'docs/_generated/'}\` manually — they are overwritten by scripts`);
  lines.push('- Do NOT skip documentation updates because "it\'s a small change" — small changes accumulate into drift');
  lines.push(`- Do NOT update \`${archFile}\` without reading the existing section first — match the format`);
  lines.push('');
  lines.push('### Session Start');
  lines.push('- At the start of every session, if `.agent-guard/session-context.md` exists, read it before making any code changes. It contains a summary of recent commits, what documentation was updated, and patterns to be aware of.');
  lines.push('- Do NOT edit `.agent-guard/session-context.md` — it is auto-generated on every commit.');

  return lines.join('\n');
}

/**
 * Regenerate standing instructions in all agent config files.
 * Finds the marker, replaces everything from marker to EOF.
 */
function refreshStandingInstructions(cfg, projectRoot, results) {
  const MARKER = '## Documentation Maintenance — Standing Instructions';
  const newInstructions = generateStandingInstructionsCJS(cfg);
  const configFiles = [
    cfg.agentConfigFile,
    ...(cfg.additionalAgentConfigs || []),
  ].filter(Boolean);

  for (const relPath of configFiles) {
    const fullPath = path.join(projectRoot, relPath);
    if (!fs.existsSync(fullPath)) continue;

    const existing = fs.readFileSync(fullPath, 'utf8');
    const markerIndex = existing.indexOf(MARKER);
    if (markerIndex === -1) continue; // no marker — don't touch

    const updated = existing.slice(0, markerIndex).trimEnd() + '\n\n' + newInstructions + '\n';
    if (updated === existing) continue; // no change

    fs.writeFileSync(fullPath, updated, 'utf8');
    try {
      execSync(`git add "${relPath}"`, { cwd: projectRoot, stdio: 'pipe' });
    } catch { /* non-fatal */ }
    results.push({ file: relPath, action: 'standing instructions refreshed' });
    if (verbose) stderr(`  Refreshed standing instructions: ${relPath}\n`);
  }
}

// ── Session Context Generator ───────────────────────────────────────────────

/**
 * Generate .agent-guard/session-context.md content.
 * Called from pre-commit hook so git add works on the result.
 */
function generateSessionContextForHook(cfg, projectRoot, lastRun) {
  const projName = cfg.projectName || 'Project';
  const lines = [];

  lines.push(`# Session Context — ${projName}`);
  lines.push('> Auto-generated by agent-guard. Do not edit manually.');
  lines.push(`> Last updated: ${new Date().toISOString()}`);
  lines.push('');

  // Recent commits from git log
  lines.push('## Recent Commits');
  lines.push('');
  lines.push('| Hash | Date | Message | Categories | Docs Updated |');
  lines.push('|------|------|---------|------------|--------------|');

  try {
    const gitLog = execSync('git log --oneline -10 --format="%h|%aI|%s"', {
      cwd: projectRoot, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
    }).trim().split('\n').filter(Boolean);

    let auditByHash = {};
    try {
      const { readLog, getLogPaths } = require('./_audit-log.cjs');
      const { logFile } = getLogPaths(projectRoot);
      const auditEntries = readLog(logFile);
      for (const e of auditEntries) {
        if (e.commitHash) auditByHash[e.commitHash] = e;
      }
    } catch { /* audit log unavailable */ }

    for (const entry of gitLog) {
      const parts = entry.split('|');
      const hash = parts[0] || '';
      const date = parts[1] ? parts[1].slice(0, 10) : '';
      const msg = parts.slice(2).join('|');
      const audit = auditByHash[hash];

      let cats = '';
      if (audit && audit.mode && audit.mode !== 'skip') {
        if (audit.categories) {
          cats = Array.isArray(audit.categories)
            ? audit.categories.join(', ')
            : Object.keys(audit.categories).join(', ');
        }
      }

      let docs = '';
      if (audit?.narrativeResults?.length > 0) {
        docs = audit.narrativeResults.map(r => r.file).join(', ');
      }

      lines.push(`| ${hash} | ${date} | ${msg.slice(0, 60)} | ${cats || '—'} | ${docs || '—'} |`);
    }
  } catch {
    lines.push('| (unable to read git log) | | | | |');
  }

  lines.push('');

  // Last hook run details
  if (lastRun) {
    lines.push('## Last Hook Run');
    lines.push('');
    if (lastRun.mode) lines.push(`**Mode:** ${lastRun.mode}`);
    if (lastRun.stagedFiles?.length > 0) {
      lines.push(`**Files staged:** ${lastRun.stagedFiles.join(', ')}`);
    }
    if (lastRun.matches && Object.keys(lastRun.matches).length > 0) {
      const catSummary = Object.entries(lastRun.matches)
        .map(([id, files]) => `${id} (${files.length})`)
        .join(', ');
      lines.push(`**Categories triggered:** ${catSummary}`);
    }
    if (lastRun.autoFixResults?.length > 0) {
      lines.push('**Auto-fix results:**');
      for (const r of lastRun.autoFixResults) {
        lines.push(`- ${r.file}: ${r.action}`);
      }
    }
    if (lastRun.engineUsed) lines.push(`**Engine:** ${lastRun.engineUsed}`);
    if (lastRun.engineError) lines.push(`**Engine error:** ${lastRun.engineError}`);
    lines.push('');
  }

  // Documentation health
  lines.push('## Documentation Health');
  lines.push('');
  lines.push(`- **Hook mode:** ${cfg.autoFix?.hook?.mode || 'advisory'}`);
  lines.push(`- **Engine:** ${cfg.autoFix?.narrative?.engine || 'claude-code'}`);

  const stalePath = path.join(projectRoot, '.agent-guard', '.docs-stale');
  if (fs.existsSync(stalePath)) {
    try {
      const stale = JSON.parse(fs.readFileSync(stalePath, 'utf8'));
      lines.push(`- **Stale marker:** YES — ${stale.reason} (${stale.timestamp})`);
    } catch {
      lines.push('- **Stale marker:** YES (unreadable)');
    }
  } else {
    lines.push('- **Stale marker:** none');
  }

  const catList = (cfg.categories || []).map(c => `${c.id} (${c.filePattern})`).join(', ');
  if (catList) lines.push(`- **Categories:** ${catList}`);
  lines.push('');

  return lines.join('\n');
}

/**
 * Write session context and stage it. Best-effort — never blocks commits.
 * @param {object} runData - { stagedFiles, matches, autoFixResults, engineUsed, engineError, mode }
 */
function writeSessionContext(runData) {
  try {
    const sessionContext = generateSessionContextForHook(config, PROJECT_ROOT, runData);
    const scDir = path.join(PROJECT_ROOT, '.agent-guard');
    if (!fs.existsSync(scDir)) fs.mkdirSync(scDir, { recursive: true });
    fs.writeFileSync(path.join(scDir, 'session-context.md'), sessionContext, 'utf8');
    execSync('git add .agent-guard/session-context.md', { cwd: PROJECT_ROOT, stdio: 'pipe' });
    if (verbose) stderr('  Updated: .agent-guard/session-context.md\n');
  } catch { /* best effort — never block commits for session context */ }
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  ensureConfig();

  // ── Hook config (CJS reader has no defaults — use inline fallbacks) ──
  const rawHookMode = config.autoFix?.hook?.mode || 'advisory';
  const hookMode = ['advisory', 'blocking'].includes(rawHookMode) ? rawHookMode : 'advisory';
  if (rawHookMode !== hookMode && verbose) {
    process.stderr.write(`\nagent-guard: unknown hook mode "${rawHookMode}", falling back to "advisory"\n`);
  }
  const blockingMode = hookMode === 'blocking';
  const checkOnly = config.autoFix?.hook?.checkOnly === true || process.argv.includes('--check-only');
  const skipIfClaudeRunning = config.autoFix?.hook?.skipIfClaudeRunning !== false; // default true

  // Auto-downgrade to advisory during rebase/merge operations
  const gitDir = path.join(PROJECT_ROOT, '.git');
  const isRebaseOrMerge = fs.existsSync(path.join(gitDir, 'rebase-merge'))
    || fs.existsSync(path.join(gitDir, 'rebase-apply'))
    || fs.existsSync(path.join(gitDir, 'MERGE_HEAD'));
  effectiveBlockingMode = blockingMode && !isRebaseOrMerge;
  if (blockingMode && isRebaseOrMerge && verbose) {
    process.stderr.write('\nagent-guard: rebase/merge detected, downgrading to advisory mode\n');
  }

  const stagedFiles = getStagedFiles();

  if (verbose) {
    stderr(`[pre-commit-doc-check] --verbose mode\n`);
    stderr(`Total staged files: ${stagedFiles.length}\n`);
    if (stagedFiles.length > 0) {
      stderr(`Staged:\n${stagedFiles.map(f => `  ${f}`).join('\n')}\n`);
    }
  }

  if (stagedFiles.length === 0) {
    if (verbose) stderr('No staged files. Nothing to check.\n');
    return 0;
  }

  const { matches, unmatched } = categorize(stagedFiles);
  const docFilesStaged = stagedFiles.some(isDocFile);
  const hasDocRelevant = Object.keys(matches).length > 0;

  if (verbose) {
    stderr(`\nCategory matches:\n`);
    for (const cat of CATEGORIES) {
      if (matches[cat.id]) {
        stderr(`  ${cat.name}: ${matches[cat.id].length} file(s)\n`);
      }
    }
    stderr(`Unmatched (ignored): ${unmatched.length}\n`);
    if (unmatched.length > 0) {
      stderr(`${unmatched.map(f => `  ${f}`).join('\n')}\n`);
    }
    stderr(`Doc files staged: ${docFilesStaged}\n`);
    stderr(`Has doc-relevant code: ${hasDocRelevant}\n`);
  }

  // No doc-relevant changes — silent pass
  if (!hasDocRelevant) {
    if (verbose) stderr('\nNo doc-relevant changes detected. ✓\n');
    return 0;
  }

  // Doc-relevant changes WITH doc updates — positive note
  // Check that narrative targets specifically were staged, not just any doc file.
  // Without this, editing docs/_generated/foo.md would bypass the staleness check.
  const archFile = (config.architectureFile || 'docs/ARCHITECTURE.md').replace(/\\/g, '/');
  const narrativeDocTargets = [
    archFile,
    ...(config.autoFix?.narrative?.additionalNarrativeTargets || ['README.md']),
  ].map(t => t.replace(/\\/g, '/'));
  const narrativeTargetsStaged = narrativeDocTargets.some(t => stagedFiles.includes(t));
  if (narrativeTargetsStaged) {
    writeSessionContext({ stagedFiles, matches, autoFixResults: [], engineUsed: null, engineError: null, mode: 'docs-included' });
    stderr('\n✓ Doc-relevant changes detected — docs also updated. Nice!\n\n');
    return 0;
  }

  // Check-only mode: report staleness, skip all AI/generator work
  if (checkOnly) {
    if (hasDocRelevant) {
      const { printBlockedMessage } = require('./_terminal-output.cjs');
      printBlockedMessage(matches, 'check-only mode detected stale documentation');
      process.stderr.write('To auto-fix: npx agent-guard sync\n');
      logEntry(PROJECT_ROOT, {
        mode: 'check-only',
        result: 'stale',
        categories: Object.keys(matches)
      });
      writeSessionContext({ stagedFiles, matches, autoFixResults: [], engineUsed: null, engineError: null, mode: 'check-only' });
      return effectiveBlockingMode ? 1 : 0;
    }
    return 0; // docs are up to date
  }

  // Self-invocation guard: skip ALL AI engines when Claude Code is committing
  // DECISION D3/D5: When Claude Code is the committer, it is responsible for updating
  // docs itself. We skip all AI (both subprocess and API) to avoid self-invocation
  // deadlock and surprise API costs. If docs are stale, exit 1 to tell Claude Code
  // to update docs before retrying.
  const { isClaudeCodeRunning } = require('./_claude-engine.cjs');
  const insideClaudeCode = skipIfClaudeRunning && isClaudeCodeRunning();

  if (insideClaudeCode) {
    if (hasDocRelevant && !narrativeTargetsStaged) {
      // Docs are stale and Claude Code is committing — block and instruct
      const { printBlockedMessage } = require('./_terminal-output.cjs');
      printBlockedMessage(matches, 'Claude Code is committing but documentation is stale');
      logEntry(PROJECT_ROOT, {
        mode: 'skipped-self-invocation',
        result: 'blocked',
        categories: Object.keys(matches)
      });
      writeSessionContext({ stagedFiles, matches, autoFixResults: [], engineUsed: null, engineError: null, mode: 'claude-code-blocked' });
      return 1; // Always exit 1 — Claude Code must update docs itself
    }
    // Docs are current — let the commit through silently
    writeSessionContext({ stagedFiles, matches, autoFixResults: [], engineUsed: null, engineError: null, mode: 'claude-code-pass' });
    return 0;
  }

  // ── Doc-relevant changes WITHOUT doc updates — auto-fix mode ──

  const autoFixResults = [];
  let engineUsed = null;
  let engineError = null;
  let autoFixRan = false;

  // Safety: refuse auto-fix if doc targets have unstaged edits
  const narrativeTargets = [
    config.architectureFile || 'docs/ARCHITECTURE.md',
    ...(config.autoFix?.narrative?.additionalNarrativeTargets || ['README.md'])
  ];
  let dirtyTargets = [];
  try {
    const unstaged = execSync('git diff --name-only', { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
    dirtyTargets = narrativeTargets.filter(t => unstaged.includes(t));
  } catch { /* ignore */ }

  if (dirtyTargets.length > 0) {
    if (verbose) {
      process.stderr.write(`\nagent-guard: skipping auto-fix — doc files have unstaged edits: ${dirtyTargets.join(', ')}\n`);
    }
    engineError = `Skipped auto-fix: ${dirtyTargets.join(', ')} have unstaged changes that would be overwritten`;
    // Fall through to output/exit — blocking mode will exit 1
  }

  // Step 1: Auto-run generators (skip if dirty-target error already set)
  if (!engineError && config.autoFix?.generators !== false) {
    const genCommands = [];
    for (const cat of CATEGORIES) {
      if (matches[cat.id] && cat.genCommand && !genCommands.includes(cat.genCommand)) {
        genCommands.push(cat.genCommand);
      }
    }

    for (const cmd of genCommands) {
      try {
        execSync(cmd, { cwd: PROJECT_ROOT, stdio: 'pipe' });
        autoFixResults.push({ file: cmd, action: 'regenerated' });
        autoFixRan = true;
      } catch (e) {
        if (verbose) stderr(`  Generator failed: ${cmd}: ${e.message}\n`);
      }
    }

    // Stage generated files
    if (autoFixRan) {
      try {
        const genDir = config.generatedDir || 'docs/_generated/';
        execSync(`git add "${genDir}"`, { cwd: PROJECT_ROOT, stdio: 'pipe' });
      } catch {
        // Non-fatal — generated files may not have changed
      }
    }
  }

  // Step 2: Narrative update via Claude Code or API
  const triggeredIds = Object.keys(matches);
  const narrativeTriggers = config.autoFix?.narrative?.narrativeTriggers || ['api-routes', 'prisma', 'env'];
  const hasNarrativeTrigger = triggeredIds.some(id => narrativeTriggers.includes(id));
  let narrativeRan = false;

  if (!engineError && hasNarrativeTrigger && config.autoFix?.narrative?.enabled !== false) {
    const engine = config.autoFix?.narrative?.engine || 'claude-code';

    if (engine === 'api') {
      // === NEW: Direct API engine ===
      stderr('  Using Anthropic API engine...\n');
      engineUsed = 'api';

      try {
        const result = await claudeEngine.invokeApiEngine({
          mode: 'narrative',
          config,
          projectRoot: PROJECT_ROOT,
          matches,
          onProgress: (msg) => stderr(`  ${msg}\n`),
        });

        if (result.success && result.files && result.files.length > 0) {
          // Write updated files to disk
          for (const f of result.files) {
            const fullPath = path.join(PROJECT_ROOT, f.path);
            fs.writeFileSync(fullPath, f.content, 'utf8');
            if (verbose) stderr(`  Updated: ${f.path}\n`);
          }

          // Staging and review use existing logic below
          narrativeRan = true;
          autoFixRan = true;
        } else if (result.success && (!result.files || result.files.length === 0)) {
          stderr('  API reports no documentation changes needed.\n');
        } else {
          engineError = result.error;
          stderr(`  API engine failed: ${result.error}. Falling back to prompt mode.\n`);
        }
      } catch (err) {
        engineError = err.message;
        stderr(`  API engine error: ${err.message}. Falling back to prompt mode.\n`);
      }

    } else {
      // === EXISTING: Claude Code subprocess engine ===
      const detected = claudeEngine.detectEngine();

      if (detected) {
        engineUsed = detected;
        const prompt = buildNarrativePrompt(matches, config);
        const result = claudeEngine.invokeClaudeCode(prompt, PROJECT_ROOT, (msg) => stderr(`  ${msg}\n`));

        if (result.success) {
          narrativeRan = true;
          autoFixRan = true;
        } else {
          engineError = result.error;
        }
      } else {
        engineError = 'Claude Code not found on PATH. Install: npm i -g @anthropic-ai/claude-code';
      }
    }

    // Shared logic for narrative updates (both engines)
    if (narrativeRan) {
      // Compute narrative targets
      const archFile = config.architectureFile || 'docs/ARCHITECTURE.md';
      const targets = [
        archFile,
        ...(config.autoFix?.narrative?.additionalNarrativeTargets || ['README.md']),
      ];

      // Review mode
      if (config.autoFix?.narrative?.review === true) {
        // Check if terminal is available
        let canInteract = false;
        // Skip interactive TTY access in CI, headless environments, or non-TTY contexts
        if (process.env.CI || !process.stderr.isTTY) {
          canInteract = false;
        } else {
          try {
            const ttyPath = process.platform === 'win32' ? '//./CON' : '/dev/tty';
            const fd = fs.openSync(ttyPath, 'r');
            fs.closeSync(fd);
            canInteract = true;
          } catch {
            canInteract = false;
          }
        }

        if (canInteract) {
          stderr('\n  Review AI doc changes:\n');
          for (const target of targets) {
            try {
              const diff = execSync(`git diff -- "${target}"`, {
                cwd: PROJECT_ROOT,
                encoding: 'utf8',
                stdio: ['pipe', 'pipe', 'pipe'],
              });
              if (diff.trim()) {
                stderr(`\n--- ${target} ---\n`);
                stderr(diff);
              }
            } catch {
              // File may not exist or no changes
            }
          }

          // Read from /dev/tty, not stdin (git hooks have stdin as /dev/null)
          const ttyPath = process.platform === 'win32' ? '//./CON' : '/dev/tty';
          const ttyFd = fs.openSync(ttyPath, 'r');
          const ttyInput = fs.createReadStream(null, { fd: ttyFd });
          const rl = readline.createInterface({ input: ttyInput, output: process.stderr });

          const answer = await new Promise((resolve) => {
            rl.question('  Stage these changes? (y/n): ', resolve);
          });
          rl.close();
          ttyInput.destroy();

          if (answer.toLowerCase() !== 'y') {
            // Discard changes
            for (const target of targets) {
              try { execSync(`git checkout -- "${target}"`, { cwd: PROJECT_ROOT, stdio: 'pipe' }); } catch { /* ignore */ }
            }
            stderr('  AI changes discarded.\n');
            engineError = 'Changes rejected by review.';
            narrativeRan = false;
            autoFixRan = false;
          }
        }
      }

      // Stage narrative targets (unless rejected by review)
      if (!engineError) {
        for (const target of targets) {
          try {
            execSync(`git add "${target}"`, { cwd: PROJECT_ROOT, stdio: 'pipe' });
            autoFixResults.push({ file: target, action: `narrative updated by ${engineUsed}` });
          } catch {
            // File may not exist
          }
        }

        // Write signal file for prepare-commit-msg hook
        const signalDir = path.join(PROJECT_ROOT, '.agent-guard');
        if (!fs.existsSync(signalDir)) fs.mkdirSync(signalDir, { recursive: true });
        fs.writeFileSync(path.join(signalDir, '.auto-fix-ran'), '', 'utf8');
      }
    }
  }

  // Step 2b: Refresh standing instructions in agent config files
  if (autoFixRan && !engineError) {
    refreshStandingInstructions(config, PROJECT_ROOT, autoFixResults);
  }

  // Step 3: Output results
  if (autoFixResults.length > 0 && !engineError) {
    printAutoFixSummary(autoFixResults);
  } else {
    // Fall back to prompt mode (existing behavior)
    const reason = engineError || null;

    stderr('\n');
    stderr('⚠️  Documentation may need updating\n');
    stderr('━'.repeat(34) + '\n');
    stderr('\n');

    // List changed categories
    stderr('Changed:\n');
    for (const cat of CATEGORIES) {
      if (!matches[cat.id]) continue;
      const files = matches[cat.id];
      const count = `(${files.length} file${files.length !== 1 ? 's' : ''})`;
      stderr(`  ${cat.emoji}  ${cat.name} ${count}:\n`);
      const show = files.slice(0, 10);
      for (const f of show) {
        stderr(`     - ${f}\n`);
      }
      if (files.length > 10) {
        stderr(`     ... and ${files.length - 10} more\n`);
      }
    }

    // Gen commands to run
    const genCmds = [];
    for (const cat of CATEGORIES) {
      if (matches[cat.id] && cat.genCommand && !genCmds.includes(cat.genCommand)) {
        genCmds.push(cat.genCommand);
      }
    }
    if (genCmds.length > 0) {
      stderr('\nRun these inventory commands:\n');
      for (const cmd of genCmds) {
        stderr(`  ${cmd}\n`);
      }
    }

    printPromptFallback(reason, buildPrompt(matches));
  }

  // Step 4: Audit log
  logEntry(PROJECT_ROOT, {
    mode: autoFixRan ? 'auto-fix' : (Object.keys(matches).length > 0 ? 'prompt' : 'skip'),
    engine: engineUsed,
    generatorResults: autoFixResults.filter(r => r.action === 'regenerated'),
    narrativeResults: autoFixResults.filter(r => r.action.includes('narrative')),
  });

  // Step 5: Generate session context
  writeSessionContext({
    stagedFiles, matches, autoFixResults, engineUsed, engineError,
    mode: autoFixRan ? 'auto-fix' : (Object.keys(matches).length > 0 ? 'prompt' : 'skip'),
  });

  // Step 6: Determine exit code
  if (!effectiveBlockingMode) {
    return 0; // Advisory mode — never block
  }

  if (!engineError) {
    return 0; // Auto-fix succeeded
  }

  // DECISION D1: Lenient degrade on engine failure
  // If engine failed because it's unavailable (API down, timeout, auth error),
  // degrade to advisory — don't punish developers for infrastructure issues.
  // Write a .docs-stale marker so the next session can detect and fix it.
  const isEngineFault = engineError.includes('timeout') ||
    engineError.includes('401') || engineError.includes('429') ||
    engineError.includes('fetch') || engineError.includes('ENOTFOUND') ||
    engineError.includes('not found') || engineError.includes('not available');

  if (isEngineFault) {
    // Engine unavailable — degrade to advisory, write stale marker
    process.stderr.write(
      `\n⚠️  agent-guard: engine unavailable, degrading to advisory mode\n` +
      `Reason: ${engineError}\n` +
      `A .agent-guard/.docs-stale marker has been written. Run "npx agent-guard sync" to fix.\n\n`
    );
    try {
      const staleDir = path.join(PROJECT_ROOT, '.agent-guard');
      if (!fs.existsSync(staleDir)) fs.mkdirSync(staleDir, { recursive: true });
      fs.writeFileSync(path.join(staleDir, '.docs-stale'), JSON.stringify({
        timestamp: new Date().toISOString(),
        reason: engineError,
        categories: Object.keys(matches)
      }), 'utf8');
    } catch { /* best effort */ }
    return 0; // Degrade to advisory — not the developer's fault
  }

  // Auto-fix failed for a fixable reason (dirty files, config issue, etc.) — block
  const { printBlockedMessage: printBlocked } = require('./_terminal-output.cjs');
  printBlocked(matches, engineError);
  return 1;
}

if (require.main === module) {
  main().then(code => {
    process.exitCode = code ?? 0;
  }).catch((e) => {
    if (verbose) {
      process.stderr.write(`[pre-commit-doc-check] Unexpected error: ${e.message}\n`);
    }
    process.exitCode = effectiveBlockingMode ? 1 : 0;
  }).finally(() => {
    process.exit(process.exitCode ?? 0);
  });
}

module.exports = {
  // Exported for testing only
  _test: {
    getStagedFiles,
    categorize,
  }
};
