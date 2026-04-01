'use strict';
/**
 * prepare-commit-msg hook handler.
 * Appends "(docs auto-updated by agent-guard)" when the pre-commit hook
 * staged auto-fix changes (signaled via .agent-guard/.auto-fix-ran).
 *
 * Session context generation has been moved to pre-commit-doc-check.cjs
 * where git add works reliably.
 */

const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.join(__dirname, '..');
const SIGNAL_FILE = path.join(PROJECT_ROOT, '.agent-guard', '.auto-fix-ran');
const COMMIT_MSG_FILE = process.argv[2]; // Git passes this as first argument

/**
 * Append auto-fix suffix to commit message.
 * Exported for testing.
 * @param {string} originalMsg
 * @returns {string}
 */
function appendAutoFixMessage(originalMsg) {
  const suffix = '\n\n(docs auto-updated by agent-guard)';
  if (originalMsg.includes('docs auto-updated by agent-guard')) {
    return originalMsg; // Don't double-append
  }
  return originalMsg.trimEnd() + suffix + '\n';
}

// Main execution
if (COMMIT_MSG_FILE && fs.existsSync(SIGNAL_FILE)) {
  try {
    const msg = fs.readFileSync(COMMIT_MSG_FILE, 'utf8');
    fs.writeFileSync(COMMIT_MSG_FILE, appendAutoFixMessage(msg), 'utf8');
    // Clean up signal file
    fs.unlinkSync(SIGNAL_FILE);
  } catch {
    // Never crash — never block a commit
  }
}

process.exit(0);

module.exports = { appendAutoFixMessage };
