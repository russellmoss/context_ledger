'use strict';

const { execSync } = require('child_process');
const os = require('os');
const fs = require('fs');
const path = require('path');

/**
 * Detect if Claude Code CLI is available on PATH.
 * @returns {'claude-code'|null}
 */
function detectEngine() {
  try {
    // Use 'where' on Windows, 'which' on Unix
    const cmd = process.platform === 'win32' ? 'where claude' : 'which claude';
    execSync(cmd, { stdio: 'pipe', shell: true });
    return 'claude-code';
  } catch {
    return null;
  }
}

/**
 * Sanitize a prompt string for safe shell/stdin usage.
 * @param {string} prompt
 * @returns {string}
 */
function sanitizePrompt(prompt) {
  // Remove null bytes, normalize newlines
  return prompt.replace(/\0/g, '').replace(/\r\n/g, '\n');
}

/**
 * Classify an error from Claude Code invocation.
 * @param {string} stderr - stderr output from the failed command
 * @returns {'auth'|'offline'|'unknown'}
 */
function classifyError(stderr) {
  if (!stderr) return 'unknown';
  const lower = stderr.toLowerCase();
  if (lower.includes('not authenticated') || lower.includes('login') || lower.includes('unauthorized')) {
    return 'auth';
  }
  if (lower.includes('enotfound') || lower.includes('network') || lower.includes('offline')) {
    return 'offline';
  }
  return 'unknown';
}

/**
 * Invoke Claude Code with a prompt via temp file (avoids stdin piping issues on Windows).
 *
 * @param {string} prompt - The full prompt to send
 * @param {string} cwd - Working directory (project root)
 * @param {function} onProgress - Callback for progress updates
 * @returns {{ success: boolean, output: string, error: string|null }}
 */
function invokeClaudeCode(prompt, cwd, onProgress) {
  if (onProgress) onProgress('Calling Claude Code for narrative doc updates...');

  const sanitized = sanitizePrompt(prompt);

  // Write prompt to temp file to avoid stdin piping issues on Windows
  const tempFile = path.join(os.tmpdir(), `claude-prompt-${Date.now()}-${process.pid}.txt`);

  try {
    fs.writeFileSync(tempFile, sanitized, 'utf8');

    // Use shell-level file redirection instead of Node's input option
    // This avoids the stdin piping timeout issue on Windows
    const cmd = `claude -p - < "${tempFile}"`;

    const output = execSync(cmd, {
      cwd,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 120000,            // 2 minute safety valve
      shell: true,                // Required on Windows for npm-installed CLIs
    });

    if (onProgress) onProgress('Claude Code finished updating docs');
    return { success: true, output: output.trim(), error: null };
  } catch (err) {
    const errType = classifyError(err.stderr || '');

    let message;
    if (errType === 'auth') {
      message = 'Log in to Claude Code for automatic doc updates: claude login';
    } else if (errType === 'offline') {
      message = 'Claude Code unavailable (offline). Falling back to prompt mode.';
    } else {
      message = `Claude Code failed: ${(err.message || '').slice(0, 200)}. Falling back to prompt mode.`;
    }

    return { success: false, output: '', error: message };
  } finally {
    // Clean up temp file
    try {
      if (fs.existsSync(tempFile)) {
        fs.unlinkSync(tempFile);
      }
    } catch {
      // Ignore cleanup errors
    }
  }
}

/**
 * Parse API response to extract updated file contents.
 * Looks for <updated-file path="...">content</updated-file> markers.
 * @param {string} responseText - Raw text from API response
 * @param {string[]} expectedPaths - List of file paths we expect to find
 * @returns {{ files: Array<{path: string, content: string}>, warnings: string[] }}
 */
function parseApiResponse(responseText, expectedPaths) {
  const files = [];
  const warnings = [];
  const regex = /<updated-file\s+path="([^"]+)">\s*([\s\S]*?)\s*<\/updated-file>/g;

  // Normalize expected paths to forward slashes for comparison
  const normalizedExpected = expectedPaths.map(p => p.replace(/\\/g, '/'));

  let match;
  while ((match = regex.exec(responseText)) !== null) {
    const rawPath = match[1].trim();
    const content = match[2];
    const normalizedPath = rawPath.replace(/\\/g, '/');

    const idx = normalizedExpected.indexOf(normalizedPath);
    if (idx !== -1) {
      // Use the original expected path so downstream file writes use the right separator
      files.push({ path: expectedPaths[idx], content });
    } else {
      warnings.push(`Ignoring unexpected file in response: ${rawPath}`);
    }
  }

  if (files.length === 0) {
    warnings.push('No <updated-file> markers found in API response.');
  }

  return { files, warnings };
}

/**
 * Build the API prompt with file contents included.
 * Unlike the subprocess prompt, this embeds actual file contents since the API can't read from disk.
 *
 * @param {object} opts
 * @param {string} opts.mode - 'sync' (full audit) or 'narrative' (incremental)
 * @param {object} opts.config - agent-guard config
 * @param {string} opts.projectRoot - Absolute path to project root
 * @param {object} [opts.matches] - For narrative mode: { categoryId: [filePaths] }
 * @returns {{ system: string, user: string, targets: string[] }}
 */
function buildApiPrompt({ mode, config, projectRoot, matches }) {
  const archFile = (config.architectureFile || 'docs/ARCHITECTURE.md').replace(/\\/g, '/');
  const additionalTargets = (config.autoFix?.narrative?.additionalNarrativeTargets || ['README.md'])
    .map(t => t.replace(/\\/g, '/'));
  const targets = [archFile, ...additionalTargets];
  const genDir = config.generatedDir || 'docs/_generated/';

  // --- Read target files (docs we'll update) ---
  const targetContents = [];
  for (const t of targets) {
    const fullPath = path.join(projectRoot, t);
    if (fs.existsSync(fullPath)) {
      targetContents.push({ path: t, content: fs.readFileSync(fullPath, 'utf8') });
    }
  }

  // --- Read generated inventories ---
  const inventoryContents = [];
  const invDir = path.join(projectRoot, genDir);
  if (fs.existsSync(invDir)) {
    const invFiles = fs.readdirSync(invDir).filter(f => f.endsWith('.md'));
    for (const f of invFiles) {
      const fullPath = path.join(invDir, f);
      const relPath = path.join(genDir, f).replace(/\\/g, '/');
      inventoryContents.push({ path: relPath, content: fs.readFileSync(fullPath, 'utf8') });
    }
  }

  // --- Read changed source files (narrative mode only) ---
  const sourceContents = [];
  if (mode === 'narrative' && matches) {
    const maxFiles = 15;
    const maxFileSizeBytes = 50 * 1024; // 50KB per file
    let fileCount = 0;

    for (const [catId, files] of Object.entries(matches)) {
      for (const f of files) {
        if (fileCount >= maxFiles) break;
        const fullPath = path.join(projectRoot, f);
        if (fs.existsSync(fullPath)) {
          const stat = fs.statSync(fullPath);
          if (stat.size <= maxFileSizeBytes) {
            sourceContents.push({ path: f, content: fs.readFileSync(fullPath, 'utf8') });
            fileCount++;
          }
        }
      }
    }
  }

  // --- Build system prompt ---
  const system = `You are a technical documentation assistant for the ${config.projectName || 'project'} project (${config.techStack?.framework || 'unknown framework'}).
Your task is to update documentation files to accurately reflect code changes.

RULES:
- Match the existing format and section structure in each file
- Preserve all existing content that is still accurate
- Only update sections affected by the code changes
- Do NOT invent or fabricate information — only document what exists in the source files
- Do NOT modify any source code files
- Do NOT modify agent config files (.cursorrules, CLAUDE.md, etc.)
- Do NOT create new files — only update existing ones

OUTPUT FORMAT:
Return each updated file wrapped in <updated-file path="...">...</updated-file> tags.
Include the COMPLETE file content, not patches or diffs.
Only return files that actually need changes.
If no files need changes, respond with: <no-changes-needed/>`;

  // --- Build user message ---
  let user = '';

  if (mode === 'sync') {
    user += `Perform a FULL documentation audit of this project.\n`;
    user += `Compare the generated inventories against the documentation and update any sections that are out of date.\n\n`;
  } else {
    user += `The following code files were changed. Update the documentation to reflect these changes.\n\n`;
  }

  // Current documentation
  user += `## Current Documentation\n\n`;
  for (const t of targetContents) {
    user += `<file path="${t.path}">\n${t.content}\n</file>\n\n`;
  }

  // Generated inventories
  user += `## Generated Inventories (authoritative, machine-generated)\n\n`;
  for (const inv of inventoryContents) {
    user += `<file path="${inv.path}">\n${inv.content}\n</file>\n\n`;
  }

  // Changed source files (narrative only)
  if (mode === 'narrative' && sourceContents.length > 0) {
    user += `## Changed Source Files\n\n`;
    for (const src of sourceContents) {
      user += `<file path="${src.path}">\n${src.content}\n</file>\n\n`;
    }
  }

  // Categories monitored (sync only — gives full picture)
  if (mode === 'sync' && config.categories) {
    user += `## Categories Monitored\n\n`;
    for (const cat of config.categories) {
      user += `- ${cat.name} (${cat.filePattern})\n`;
    }
    user += `\n`;
  }

  // File list for narrative mode
  if (mode === 'narrative' && matches) {
    user += `## Changed File Summary\n\n`;
    for (const [catId, files] of Object.entries(matches)) {
      const cat = (config.categories || []).find(c => c.id === catId);
      const name = cat ? cat.name : catId;
      user += `### ${name} (${files.length} file(s))\n`;
      for (const f of files) {
        user += `- ${f}\n`;
      }
      user += `\n`;
    }
  }

  user += `## Instructions\n\n`;
  user += `Update the documentation files listed above to reflect the ${mode === 'sync' ? 'current state of the codebase' : 'changes in the source files'}.\n`;
  user += `Return each updated file wrapped in <updated-file path="...">complete file content</updated-file> tags.\n`;
  user += `Only return files that actually need changes.\n`;

  return { system, user, targets };
}

/**
 * Invoke the Anthropic Messages API directly.
 * Uses native fetch (Node 20+). Zero dependencies.
 * Returns same shape as invokeClaudeCode for seamless integration.
 *
 * @param {object} opts
 * @param {string} opts.mode - 'sync' or 'narrative'
 * @param {object} opts.config - agent-guard config
 * @param {string} opts.projectRoot - Absolute path to project root
 * @param {object} [opts.matches] - For narrative mode: { categoryId: [filePaths] }
 * @param {function} [opts.onProgress] - Progress callback
 * @returns {Promise<{ success: boolean, output: string, error: string|null, files?: Array<{path: string, content: string}> }>}
 */
async function invokeApiEngine({ mode, config, projectRoot, matches, onProgress }) {
  const narrativeCfg = config.autoFix?.narrative || {};

  // --- Resolve API key ---
  const envVarName = narrativeCfg.apiKeyEnv || 'ANTHROPIC_API_KEY';
  let apiKey = process.env[envVarName];

  if (!apiKey) {
    // Try .env file
    const envPath = path.join(projectRoot, '.env');
    if (fs.existsSync(envPath)) {
      const content = fs.readFileSync(envPath, 'utf-8');
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
        const eqIdx = trimmed.indexOf('=');
        const key = trimmed.slice(0, eqIdx).trim();
        let value = trimmed.slice(eqIdx + 1).trim();
        if ((value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1);
        }
        if (key === envVarName) { apiKey = value; break; }
      }
    }
  }

  if (!apiKey) {
    return {
      success: false,
      output: '',
      error: `API key not found. Set ${envVarName} in your environment or .env file.`,
    };
  }

  // --- Build prompt ---
  if (onProgress) onProgress('Building API prompt with file contents...');
  const { system, user, targets } = buildApiPrompt({ mode, config, projectRoot, matches });

  // --- Call API ---
  const model = narrativeCfg.model || 'claude-sonnet-4-20250514';
  const maxTokens = narrativeCfg.maxTokens || 32000;
  const timeout = narrativeCfg.timeout || 120000;

  if (onProgress) onProgress(`Calling Anthropic API (${model})...`);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        system,
        messages: [{ role: 'user', content: user }],
      }),
      signal: controller.signal,
    });

    clearTimeout(timer);

    if (!response.ok) {
      const errorText = await response.text();
      const status = response.status;

      if (status === 401) {
        return { success: false, output: '', error: `Invalid API key. Check ${envVarName}.` };
      }
      if (status === 429) {
        return { success: false, output: '', error: 'Rate limited by Anthropic API. Try again in 60 seconds.' };
      }
      return { success: false, output: '', error: `Anthropic API error (${status}): ${errorText.slice(0, 200)}` };
    }

    const data = await response.json();

    // Extract text content
    let responseText = '';
    if (data.content) {
      for (const block of data.content) {
        if (block.type === 'text') {
          responseText += block.text;
        }
      }
    }

    // Check for truncation
    if (data.stop_reason !== 'end_turn') {
      return {
        success: false,
        output: responseText,
        error: `Response truncated (stop_reason: ${data.stop_reason}). Try reducing file count or increasing maxTokens.`,
      };
    }

    // Check for no-changes-needed
    if (responseText.includes('<no-changes-needed/>') || responseText.includes('<no-changes-needed />')) {
      if (onProgress) onProgress('API reports no documentation changes needed.');
      return { success: true, output: responseText, error: null, files: [] };
    }

    // Parse file updates from response
    const parsed = parseApiResponse(responseText, targets);

    if (parsed.warnings.length > 0 && parsed.files.length === 0) {
      return {
        success: false,
        output: responseText,
        error: `Response parsing failed: ${parsed.warnings.join('; ')}`,
      };
    }

    for (const w of parsed.warnings) {
      if (onProgress) onProgress(`Warning: ${w}`);
    }

    if (onProgress) {
      onProgress(`API returned updates for ${parsed.files.length} file(s) (${data.usage?.input_tokens || '?'} input, ${data.usage?.output_tokens || '?'} output tokens)`);
    }

    return {
      success: true,
      output: responseText,
      error: null,
      files: parsed.files,
    };

  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') {
      return { success: false, output: '', error: `API request timed out after ${timeout / 1000}s.` };
    }
    return { success: false, output: '', error: `API request failed: ${err.message}` };
  }
}

/**
 * Detect if this process was spawned by Claude Code.
 * Claude Code sets CLAUDECODE=1 and CLAUDE_CODE_ENTRYPOINT in child processes.
 * Pure env check — zero cost, no subprocess, cross-platform.
 *
 * When true, the hook skips ALL AI engines (both subprocess and API) to prevent
 * self-invocation deadlock and avoid surprise API costs. Claude Code is responsible
 * for updating docs itself before retrying the commit.
 */
function isClaudeCodeRunning() {
  return !!(process.env.CLAUDECODE || process.env.CLAUDE_CODE_ENTRYPOINT);
}

module.exports = {
  detectEngine,
  sanitizePrompt,
  classifyError,
  invokeClaudeCode,
  invokeApiEngine,
  buildApiPrompt,
  parseApiResponse,
  isClaudeCodeRunning,
};
