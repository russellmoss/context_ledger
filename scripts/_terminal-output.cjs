'use strict';

/**
 * Get emoji for a file path based on content type.
 * @param {string} filePath
 * @returns {string}
 */
function getEmoji(filePath) {
  if (filePath.includes('api-routes') || filePath.includes('route.')) return '📡';
  if (filePath.includes('prisma') || filePath.includes('model')) return '🗄️';
  if (filePath.includes('env')) return '🔑';
  if (filePath.includes('ARCHITECTURE')) return '📄';
  if (filePath.includes('README')) return '📖';
  if (filePath === 'blocked') return '🚫';
  return '📝';
}

/**
 * Print the auto-fix summary (green checkmark mode).
 * @param {Array<{file: string, action: string, detail?: string}>} results
 */
function printAutoFixSummary(results) {
  const stderr = (msg) => process.stderr.write(msg);

  stderr('\n✅ agent-guard auto-updated docs:\n');
  for (const r of results) {
    const emoji = getEmoji(r.file);
    stderr(`  ${emoji} ${r.file} — ${r.action}${r.detail ? ` (${r.detail})` : ''}\n`);
  }
  stderr('\n');
}

/**
 * Print progress during Claude Code invocation.
 * @param {string} message
 */
function printProgress(message) {
  process.stderr.write(`  ${message}\n`);
}

/**
 * Print prompt-mode fallback (yellow warning mode).
 * @param {string|null} fallbackReason - Why auto-fix didn't run
 * @param {string} prompt - The manual prompt to display
 */
function printPromptFallback(fallbackReason, prompt) {
  const stderr = (msg) => process.stderr.write(msg);

  if (fallbackReason) {
    stderr(`\n⚠️  ${fallbackReason}\n`);
  }

  stderr('\n');
  stderr('┌' + '─'.repeat(45) + '┐\n');
  stderr('│  Claude Code Prompt (copy-paste this):       │\n');
  stderr('└' + '─'.repeat(45) + '┘\n');
  stderr('\n');
  stderr(prompt);
  stderr('\n\n');
}

function printBlockedMessage(matches, reason) {
  const matchSummary = Object.entries(matches)
    .map(([cat, files]) => `  ${cat}: ${files.length} file(s)`)
    .join('\n');

  const isClaudeCode = !!(process.env.CLAUDECODE || process.env.CLAUDE_CODE_ENTRYPOINT);

  let remediation;
  if (isClaudeCode) {
    remediation =
      'CLAUDE: Documentation is stale. Read the changed source files listed above, then update docs/ARCHITECTURE.md (and any other doc targets) to reflect those changes. Stage the updated docs with git add, then retry the commit. Do NOT run npx agent-guard sync — update the files yourself directly.';
  } else {
    remediation =
      'Fix: update the documentation files listed above, then commit again.\n' +
      'To bypass this check: git commit --no-verify';
  }

  process.stderr.write(
    `\n${getEmoji('blocked')} agent-guard: commit blocked — documentation is stale\n` +
    `\nReason: ${reason}\n` +
    `\nStale categories:\n${matchSummary}\n` +
    `\n${remediation}\n\n`
  );

  // Machine-readable line on stdout for Claude Code hook handlers
  const allFiles = Object.values(matches).flat();
  process.stdout.write(`AGENT_GUARD_STALE: ${allFiles.join(' ')}\n`);
}

module.exports = { getEmoji, printAutoFixSummary, printProgress, printPromptFallback, printBlockedMessage };
