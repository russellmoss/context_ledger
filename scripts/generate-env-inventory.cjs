'use strict';
/**
 * generate-env-inventory.cjs
 * Reads the configured env example file and scans source directory for process.env references,
 * then produces a markdown inventory.
 *
 * Config-driven: reads scanPaths.envFile, scanPaths.sourceDir, generatedDir, and envCategories
 * from agent-docs.config.json
 * Run with: npm run gen:env
 */

const fs = require('fs');
const path = require('path');
const { loadConfig, resolvePath, PROJECT_ROOT } = require('./_config-reader.cjs');

const config = loadConfig();
const ENV_FILE = resolvePath(config.scanPaths?.envFile || '.env.example');
const SRC_DIR = resolvePath(config.scanPaths?.sourceDir || 'src/');
const OUTPUT_FILE = path.join(
  resolvePath(config.generatedDir || 'docs/_generated/'),
  'env-vars.md'
);

// ── Category mapping — from config instead of hardcoded ──────────────────────

const CATEGORY_RULES = (config.envCategories || []).map(rule => ({
  prefix: rule.prefix,
  category: rule.category,
}));

function getCategory(name) {
  // Sort rules by prefix length descending to match most-specific first
  const sorted = CATEGORY_RULES.slice().sort((a, b) => b.prefix.length - a.prefix.length);
  for (const rule of sorted) {
    if (name.startsWith(rule.prefix)) return rule.category;
  }
  return 'Other';
}

// ── Core parsing logic ─────────────────────────────────────────────────────

/** Parse env file and extract variables */
function parseEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    console.log(`⚠ Env file not found: ${filePath} — creating empty inventory.`);
    return [];
  }

  const lines = fs.readFileSync(filePath, 'utf8').split('\n');
  const vars = [];

  for (const line of lines) {
    const trimmed = line.trim();
    // Skip empty lines and comment lines
    if (!trimmed || trimmed.startsWith('#')) continue;

    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;

    const name = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim();

    // Must be a valid env var name (all caps, underscores, digits)
    if (!/^[A-Z][A-Z0-9_]*$/.test(name)) continue;

    const hasValue = value.length > 0;
    // Detect placeholder vs real default
    const isPlaceholder = hasValue && (
      value.startsWith('your-') ||
      value.startsWith('sk-ant-') ||
      value.includes('YOUR_') ||
      value.includes('xxxx') ||
      value.includes('your_') ||
      value === 'http://localhost:3000' ||
      value.startsWith('https://your-') ||
      value.startsWith('SG.xxxx') ||
      value.endsWith('-here') ||
      value.includes('@yourcompany.com')
    );

    vars.push({
      name,
      value,
      hasValue,
      isPlaceholder,
      category: getCategory(name),
    });
  }

  return vars;
}

/** Recursively get all source files */
function getAllSourceFiles(dir) {
  const results = [];
  let items;
  try {
    items = fs.readdirSync(dir, { withFileTypes: true });
  } catch { /* skip unreadable */
    return results;
  }
  for (const item of items) {
    const fullPath = path.join(dir, item.name);
    if (item.isDirectory()) {
      // Skip common non-source directories
      if (['node_modules', '.next', '.git', 'dist', 'build'].includes(item.name)) continue;
      results.push(...getAllSourceFiles(fullPath));
    } else if (/\.(ts|tsx|js|mjs|cjs)$/.test(item.name)) {
      results.push(fullPath);
    }
  }
  return results;
}

/** Scan source directory for process.env references */
function scanProcessEnvRefs(srcDir) {
  if (!fs.existsSync(srcDir)) {
    console.log(`⚠ Source directory not found: ${srcDir} — skipping code scan.`);
    return new Map();
  }

  const files = getAllSourceFiles(srcDir);
  const refs = new Map(); // varName → Set of file paths

  const pattern = /process\.env\.([A-Z][A-Z0-9_]*)/g;

  for (const filePath of files) {
    const content = fs.readFileSync(filePath, 'utf8');
    let match;
    while ((match = pattern.exec(content)) !== null) {
      const varName = match[1];
      if (!refs.has(varName)) refs.set(varName, new Set());
      const relPath = path.relative(PROJECT_ROOT, filePath).replace(/\\/g, '/');
      refs.get(varName).add(relPath);
    }
    pattern.lastIndex = 0; // Reset regex state
  }

  return refs;
}

// ── Main ────────────────────────────────────────────────────────────────────

const envVars = parseEnvFile(ENV_FILE);
const envVarNames = new Set(envVars.map(v => v.name));
const codeRefs = scanProcessEnvRefs(SRC_DIR);

// Mark which env vars are referenced in code
for (const v of envVars) {
  v.inCode = codeRefs.has(v.name);
}

// Find undocumented refs (in code but not in .env.example)
const undocumented = [];
for (const [varName, files] of codeRefs.entries()) {
  if (!envVarNames.has(varName)) {
    undocumented.push({ name: varName, files: [...files].sort() });
  }
}
undocumented.sort((a, b) => a.name.localeCompare(b.name));

// Group by category
const categories = {};
for (const v of envVars) {
  if (!categories[v.category]) categories[v.category] = [];
  categories[v.category].push(v);
}

// Build markdown
const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
const totalVars = envVars.length;
const totalCodeRefs = codeRefs.size;

let md = `# Environment Variables Inventory (Auto-Generated)\n\n`;
md += `> This file is auto-generated by \`npm run gen:env\`. Do not edit manually.\n`;
md += `> Generated: ${now}\n`;
md += `> Total: ${totalVars} variables in ${path.basename(ENV_FILE)}, ${totalCodeRefs} unique \`process.env\` references in source\n\n`;

// Table of all env vars grouped by category
md += `## Variables by Category\n\n`;
md += `| Variable | Category | Has Value | In Code |\n`;
md += `|----------|----------|-----------|--------|\n`;

for (const [catName, catVars] of Object.entries(categories)) {
  for (const v of catVars) {
    const hasValueStr = v.hasValue ? (v.isPlaceholder ? 'placeholder' : 'default') : 'empty';
    const inCodeStr = v.inCode ? '✓' : '—';
    md += `| \`${v.name}\` | ${catName} | ${hasValueStr} | ${inCodeStr} |\n`;
  }
}

md += '\n';

// Undocumented section
if (undocumented.length > 0) {
  md += `## Undocumented — In Code but Missing from ${path.basename(ENV_FILE)}\n\n`;
  md += `These variables are referenced via \`process.env\` in source but are not defined in \`${path.basename(ENV_FILE)}\`.\n`;
  md += `They may be automatically injected (e.g., \`VERCEL_URL\`, \`NODE_ENV\`) or may indicate missing documentation.\n\n`;
  md += `| Variable | Referenced In |\n`;
  md += `|----------|---------------|\n`;
  for (const u of undocumented) {
    const filesStr = u.files.slice(0, 3).join(', ') + (u.files.length > 3 ? ` (+${u.files.length - 3} more)` : '');
    md += `| \`${u.name}\` | ${filesStr} |\n`;
  }
  md += '\n';
} else {
  md += `## All process.env References Documented\n\n`;
  md += `No undocumented \`process.env\` references found in source.\n\n`;
}

fs.mkdirSync(path.dirname(OUTPUT_FILE), { recursive: true });
fs.writeFileSync(OUTPUT_FILE, md, 'utf8');
console.log(`✓ Generated env-vars.md: ${totalVars} variables, ${undocumented.length} undocumented references`);
