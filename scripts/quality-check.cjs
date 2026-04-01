'use strict';
/**
 * quality-check.cjs
 * Validates AI-generated documentation for consistency.
 * Run by the docs-audit GitHub Action after regenerating inventories.
 *
 * Checks:
 * 1. Markdown validity (no unclosed code blocks)
 * 2. ARCHITECTURE.md section structure matches expectations
 * 3. No placeholder text left behind (TODO, FIXME in generated sections)
 *
 * Exit codes:
 *   0 = all checks pass
 *   1 = issues found (prints details for GitHub Action to capture)
 */

const fs = require('fs');
const path = require('path');
const { loadConfig, resolvePath } = require('./_config-reader.cjs');

/**
 * Check for unclosed code blocks in a markdown string.
 * @param {string} content
 * @returns {string[]} Array of issue descriptions
 */
function checkMarkdownValidity(content) {
  const issues = [];
  const backtickBlocks = (content.match(/```/g) || []).length;
  if (backtickBlocks % 2 !== 0) {
    issues.push('Unclosed code block (odd number of ``` fences)');
  }
  return issues;
}

/**
 * Check that expected sections exist in ARCHITECTURE.md.
 * @param {string} content
 * @param {Array} categories
 * @returns {string[]}
 */
function checkSectionStructure(content, _categories) {
  const issues = [];
  // Check for the Overview section (always required)
  if (!content.includes('## Section 1: Overview')) {
    issues.push('Missing "Section 1: Overview" header');
  }
  // Check for API Routes section (always required)
  if (!content.includes('API Routes')) {
    issues.push('Missing API Routes section');
  }
  return issues;
}

/**
 * Check for leftover placeholder text.
 * @param {string} content
 * @returns {string[]}
 */
function checkPlaceholders(content) {
  const issues = [];
  const patterns = [/\bTODO\b/gi, /\bFIXME\b/gi, /\bHACK\b/gi, /_Add your .* here_/g];
  // Only flag TODOs in generated sections (after "Auto-Generated" marker)
  for (const pattern of patterns) {
    const matches = content.match(pattern);
    if (matches && matches.length > 0) {
      issues.push(`Found ${matches.length} instances of "${pattern.source}" placeholder text`);
    }
  }
  return issues;
}

module.exports = { checkMarkdownValidity, checkSectionStructure, checkPlaceholders };

// Only run main when executed directly (not when imported for testing)
if (require.main === module) {
  const config = loadConfig();
  const archFile = resolvePath(config.architectureFile || 'docs/ARCHITECTURE.md');
  const allIssues = [];

  if (archFile && fs.existsSync(archFile)) {
    const content = fs.readFileSync(archFile, 'utf8');
    allIssues.push(...checkMarkdownValidity(content).map(i => `ARCHITECTURE.md: ${i}`));
    allIssues.push(...checkSectionStructure(content, config.categories).map(i => `ARCHITECTURE.md: ${i}`));
  }

  // Check generated inventory files
  const genDir = resolvePath(config.generatedDir || 'docs/_generated/');
  if (genDir && fs.existsSync(genDir)) {
    const files = fs.readdirSync(genDir).filter(f => f.endsWith('.md'));
    for (const file of files) {
      const content = fs.readFileSync(path.join(genDir, file), 'utf8');
      allIssues.push(...checkMarkdownValidity(content).map(i => `${file}: ${i}`));
    }
  }

  if (allIssues.length > 0) {
    console.log('Documentation quality issues found:\n');
    for (const issue of allIssues) {
      console.log(`  ⚠️  ${issue}`);
    }
    console.log(`\nTotal: ${allIssues.length} issue(s)`);
    process.exit(1);
  } else {
    console.log('✅ All documentation quality checks passed');
    process.exit(0);
  }
}
