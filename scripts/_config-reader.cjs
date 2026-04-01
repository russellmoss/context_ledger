/**
 * Shared config reader for agent-guard scripts.
 * CommonJS — compatible with .cjs inventory scripts and .js hook scripts.
 *
 * Reads agent-docs.config.json from the project root and provides
 * resolved paths for all configurable values.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.join(__dirname, '..');
const CONFIG_FILE = path.join(PROJECT_ROOT, 'agent-docs.config.json');

let _cachedConfig = null;

function loadConfig() {
  if (_cachedConfig) return _cachedConfig;

  if (!fs.existsSync(CONFIG_FILE)) {
    console.error('✗ agent-docs.config.json not found at project root.');
    console.error('  Run "npx agent-guard init" to create it.');
    process.exit(1);
  }

  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    _cachedConfig = raw;
    return raw;
  } catch (err) {
    console.error(`✗ Invalid JSON in agent-docs.config.json: ${err.message}`);
    process.exit(1);
  }
}

/** Resolve a config path relative to project root */
function resolvePath(configPath) {
  if (!configPath) return null;
  return path.resolve(PROJECT_ROOT, configPath);
}

/**
 * Parse a .env file and return the value for a specific key.
 * Zero-dependency — manual parsing. Handles comments, quotes, empty lines.
 * @param {string} filePath - Absolute path to .env file
 * @param {string} keyName - Environment variable name to find
 * @returns {string|null} Value if found, null otherwise
 */
function parseEnvFile(filePath, keyName) {
  if (!fs.existsSync(filePath)) return null;

  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;

    const eqIndex = trimmed.indexOf('=');
    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1).trim();

    // Remove surrounding quotes
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    if (key === keyName) return value;
  }

  return null;
}

/**
 * Resolve the Anthropic API key from environment or .env file.
 * Resolution order:
 *   1. process.env[apiKeyEnv]
 *   2. .env file in project root
 * @param {object} config - agent-guard config
 * @param {string} projectRoot - Absolute path to project root
 * @returns {{ key: string|null, source: string }}
 */
function resolveApiKey(config, projectRoot) {
  const envVarName = config.autoFix?.narrative?.apiKeyEnv || 'ANTHROPIC_API_KEY';

  // 1. Check process.env
  if (process.env[envVarName]) {
    return { key: process.env[envVarName], source: 'environment' };
  }

  // 2. Parse .env file
  const envPath = path.join(projectRoot, '.env');
  const key = parseEnvFile(envPath, envVarName);
  if (key) {
    return { key, source: '.env file' };
  }

  return { key: null, source: 'not found' };
}

module.exports = { loadConfig, resolvePath, PROJECT_ROOT, parseEnvFile, resolveApiKey };
