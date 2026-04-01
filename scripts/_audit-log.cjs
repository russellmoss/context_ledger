'use strict';

const fs = require('fs');
const path = require('path');

const MAX_ENTRIES = 500;

/**
 * Get the audit log directory and file paths.
 * @param {string} projectRoot
 * @returns {{ logDir: string, logFile: string }}
 */
function getLogPaths(projectRoot) {
  const logDir = path.join(projectRoot, '.agent-guard');
  const logFile = path.join(logDir, 'log.json');
  return { logDir, logFile };
}

/**
 * Get current short commit hash, or 'unknown'.
 * @returns {string}
 */
function getCommitHash() {
  try {
    const { execSync } = require('child_process');
    return execSync('git rev-parse --short HEAD', { encoding: 'utf8', stdio: 'pipe' }).trim();
  } catch {
    return 'unknown';
  }
}

/**
 * Read existing log entries from disk.
 * Returns empty array if file doesn't exist or is corrupted.
 * @param {string} logFile
 * @returns {Array}
 */
function readLog(logFile) {
  try {
    if (fs.existsSync(logFile)) {
      return JSON.parse(fs.readFileSync(logFile, 'utf8'));
    }
  } catch {
    // Corrupted log — start fresh
  }
  return [];
}

/**
 * Append an entry to the audit log.
 * @param {string} projectRoot
 * @param {{ mode: string, engine?: string, generatorResults?: Array, narrativeResults?: Array }} entry
 */
function logEntry(projectRoot, entry) {
  try {
    const { logDir, logFile } = getLogPaths(projectRoot);
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });

    let log = readLog(logFile);

    log.push({
      timestamp: new Date().toISOString(),
      commitHash: getCommitHash(),
      mode: entry.mode,             // 'auto-fix' | 'prompt' | 'skip' | 'sync'
      engine: entry.engine || null,
      generatorResults: entry.generatorResults || [],
      narrativeResults: entry.narrativeResults || [],
    });

    // Trim to max entries (keep most recent)
    if (log.length > MAX_ENTRIES) {
      log = log.slice(log.length - MAX_ENTRIES);
    }

    fs.writeFileSync(logFile, JSON.stringify(log, null, 2) + '\n', 'utf8');
  } catch {
    // Never crash — logging is best-effort
  }
}

module.exports = { logEntry, readLog, getLogPaths, getCommitHash, MAX_ENTRIES };
