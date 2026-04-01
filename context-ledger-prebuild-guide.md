# Context-Ledger: Pre-Build Infrastructure Setup Guide

## What This Guide Does

This guide sets up everything you need BEFORE building context-ledger. When you finish this guide, you will have:

- A properly initialized Node.js/TypeScript project
- agent-guard configured and syncing docs
- council-of-models-mcp registered and verified
- Adapted agents (code-inspector, pattern-finder, dependency-mapper) for this codebase
- Adapted slash commands (/auto-feature, /council, /refine, /quick-update) tailored for context-ledger
- Standing instructions (CLAUDE.md) with project context
- The v2.3 design doc loaded as the single source of truth
- A working /auto-feature pipeline ready to generate the implementation guide

**Do NOT build context-ledger features during this guide.** This is infrastructure only.

---

## PHASE 1: Project Scaffold

### Context
Create the repo, initialize npm, configure TypeScript, set up the directory structure that matches the package design in the v2.3 spec.

### Step 1.1: Create the repo and initialize

**Claude Code prompt:**
```
Create a new directory at C:\Users\russe\Documents\context-ledger and initialize it:

1. mkdir the directory
2. cd into it
3. git init
4. npm init with these exact values from the design spec:
   - name: context-ledger
   - version: 0.1.0
   - description: "Decision capture and retrieval system for AI-assisted development"
   - type: module
   - engines.node: ">=18.0.0"
   - bin entries:
     - context-ledger: dist/cli.js
     - context-ledger-mcp: dist/mcp-server.js
     - context-ledger-setup: dist/setup.js
   - files: ["dist/", "examples/", "README.md", "QUICKSTART.md"]
   - scripts:
     - build: tsc
     - dev: tsc --watch
     - clean: rimraf dist
     - rebuild: npm run clean && npm run build
     - start: node dist/cli.js
     - smoke: node dist/smoke.js
     - setup: node dist/setup.js
     - prepublishOnly: npm run rebuild
   - license: ISC
   - author: Russell Moss
   - repository: { type: git, url: https://github.com/russellmoss/context-ledger }
5. Add @clack/prompts as the single runtime dependency
6. Add devDependencies: typescript, @types/node, rimraf, @modelcontextprotocol/sdk, zod
7. npm install
```

### Step 1.2: TypeScript configuration

**Claude Code prompt:**
```
Create tsconfig.json in C:\Users\russe\Documents\context-ledger with these exact settings (matching council-mcp's proven config):

{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

### Step 1.3: Directory structure

**Claude Code prompt:**
```
Create the following directory structure in C:\Users\russe\Documents\context-ledger:

src/
├── index.ts              # MCP server entry point (add shebang: #!/usr/bin/env node)
├── cli.ts                # CLI entry point (add shebang)
├── setup.ts              # Interactive setup wizard (add shebang)
├── config.ts             # Default config, scope mappings, hint mappings
├── smoke.ts              # Provider smoke test
├── ledger/
│   ├── index.ts          # Barrel export
│   ├── events.ts         # Decision and transition event types
│   ├── fold.ts           # Event log fold logic (compute current state)
│   ├── inbox.ts          # Inbox queue management (TTL, lifecycle)
│   └── validate.ts       # Integrity checks, propose-repair
├── capture/
│   ├── index.ts          # Barrel export
│   ├── hook.ts           # Post-commit hook classifier logic
│   └── classify.ts       # Structural change classification (Tier 1/2)
├── retrieval/
│   ├── index.ts          # Barrel export
│   ├── query.ts          # query_decisions implementation
│   ├── scope.ts          # Scope derivation (file path → scope, config mappings, directory fallback)
│   └── packs.ts          # Decision pack builder with token budgeting
└── mcp/
    ├── index.ts          # MCP tool registrations
    ├── read-tools.ts     # query_decisions, search_decisions
    └── write-tools.ts    # confirm_pending, reject_pending, supersede_decision, record_writeback, propose_decision

examples/
└── claude-commands/
    ├── decision.md       # Manual capture command
    └── check-decisions.md # Query ledger for current task

docs/                     # Will be populated by agent-guard
.claude/
├── commands/             # Slash commands (populated in Phase 4)
├── agents/               # Agent definitions (populated in Phase 3)
└── skills/               # Skills (populated in Phase 3)

Create placeholder index.ts files in each src/ subdirectory with just a comment:
// context-ledger - [subdirectory name]
// Implementation pending — see context-ledger-design-v2.md

Create the shebang entry points (src/index.ts, src/cli.ts, src/setup.ts) with:
#!/usr/bin/env node
// context-ledger - [entry point name]
// Implementation pending
```

### Step 1.4: Git configuration

**Claude Code prompt:**
```
Create .gitignore in C:\Users\russe\Documents\context-ledger:

node_modules/
dist/
.env
*.js.map
.context-ledger/inbox.jsonl
.agent-guard/.auto-fix-ran
.agent-guard/.docs-stale

Create .env.example:

# Council of Models MCP (for adversarial review during development)
OPENAI_API_KEY=sk-your-key-here
GEMINI_API_KEY=your-key-here

# agent-guard API engine (for auto-fix narrative docs)
ANTHROPIC_API_KEY=sk-ant-your-key-here

Create the initial .env by copying API keys from C:\Users\russe\Documents\Dashboard\.env — 
copy only OPENAI_API_KEY, GEMINI_API_KEY, and ANTHROPIC_API_KEY values.
Do NOT commit .env. Verify .gitignore excludes it.
```

### PHASE 1 — VALIDATION GATE

```bash
cd C:\Users\russe\Documents\context-ledger
node -e "const p = require('./package.json'); console.log(p.name, p.version, Object.keys(p.bin))"
# Expected: context-ledger 0.1.0 [ 'context-ledger', 'context-ledger-mcp', 'context-ledger-setup' ]

npx tsc --noEmit 2>&1 | head -5
# Expected: No errors (empty src files with comments only)

ls src/ledger/ src/capture/ src/retrieval/ src/mcp/
# Expected: All subdirectories exist with index.ts files

cat .env | grep -c "KEY"
# Expected: 3 (three API keys present)

git status
# Expected: Clean working tree or initial untracked files ready to commit
```

**STOP AND REPORT**: Confirm project scaffold is complete. Make initial commit:
```bash
git add -A
git commit -m "chore: initial project scaffold for context-ledger"
```

---

## PHASE 2: Agent-Guard Setup

### Context
Install and configure agent-guard so documentation stays in sync from the very first commit. This is the "build fences before you let the LLM loose" principle.

### Step 2.1: Install agent-guard

**Claude Code prompt:**
```
cd C:\Users\russe\Documents\context-ledger
npm install --save-dev @mossrussell/agent-guard
npx agent-guard init
```

When the interactive wizard runs, use these settings:
- Project name: context-ledger
- Architecture file: docs/ARCHITECTURE.md
- Agent config file: CLAUDE.md
- Scan paths: use defaults (src/app/api/ won't exist, that's fine — we'll customize)
- Auto-fix engine: api (uses ANTHROPIC_API_KEY from .env)
- Hook mode: advisory (exit 0) for now — we'll switch to blocking later

### Step 2.2: Configure agent-guard for context-ledger's structure

**Claude Code prompt:**
```
Read C:\Users\russe\Documents\context-ledger\agent-docs.config.json and update it:

1. Set projectName to "context-ledger"
2. Set architectureFile to "docs/ARCHITECTURE.md"
3. Set agentConfigFile to "CLAUDE.md"
4. Set additionalAgentConfigs to [] (we only need CLAUDE.md for now)
5. Update scanPaths to match our project:
   - apiRoutes: leave default or remove (we don't have API routes — we have MCP tools)
   - prismaSchema: remove (no Prisma)
   - envFile: ".env.example"
6. Set autoFix.narrative.enabled to true
7. Set autoFix.narrative.engine to "api"
8. Set autoFix.narrative.narrativeTriggers to whatever categories were generated
9. Set autoFix.hook.mode to "advisory"
10. Set autoFix.hook.skipIfClaudeRunning to true
```

### Step 2.3: Create initial ARCHITECTURE.md

**Claude Code prompt:**
```
Create docs/ARCHITECTURE.md in C:\Users\russe\Documents\context-ledger with this content:

# context-ledger Architecture

## Overview
context-ledger is a decision capture and retrieval system for AI-assisted development. 
It records the "why" behind architectural choices and makes that reasoning retrievable 
via MCP so AI agents stop repeating mistakes.

## Tech Stack
- Runtime: Node.js 18+ (ES modules)
- Language: TypeScript (strict mode)
- MCP SDK: @modelcontextprotocol/sdk
- Interactive UI: @clack/prompts
- Storage: Local JSONL (event-sourced, append-only)

## Architecture
- Entry points: CLI (cli.ts), MCP Server (index.ts), Setup Wizard (setup.ts)
- Ledger: Event-sourced JSONL with decision records and transition events
- Inbox: Structured JSONL queue with TTL and lifecycle management
- Capture: Post-commit hook (instantaneous, zero LLM calls) + workflow write-back
- Retrieval: MCP server with file-path-first scope derivation and decision packs
- Integration: Designed to work alongside agent-guard and council-of-models-mcp

## Key Design Decisions
See context-ledger-design-v2.md for the full design spec with 47 traced decisions 
from 4 rounds of adversarial review.

## Module Map
- src/ledger/ — Event types, fold logic, inbox management, validation
- src/capture/ — Post-commit hook, change classification
- src/retrieval/ — query_decisions, scope derivation, decision pack builder
- src/mcp/ — MCP tool registrations (read + write tools)
- src/cli.ts — CLI commands (init, validate, tidy, stats, export, backfill)
- src/setup.ts — Interactive setup wizard (@clack/prompts)
- src/config.ts — Default configuration, scope mappings, hint mappings

## Ecosystem
- agent-guard: Keeps the "what" accurate (inventories, doc sync, session context)
- context-ledger: Keeps the "why" accessible (decisions, precedents, abandoned approaches)
- council-of-models-mcp: Keeps the "review" adversarial (cross-LLM validation)
```

### Step 2.4: Run initial sync

**Claude Code prompt:**
```
cd C:\Users\russe\Documents\context-ledger
npx agent-guard gen
npx agent-guard sync
git add -A
git status
```

Review what agent-guard generated. Stage everything that looks correct.

### PHASE 2 — VALIDATION GATE

```bash
cd C:\Users\russe\Documents\context-ledger

# Verify agent-guard config exists and is valid JSON
node -e "const c = require('./agent-docs.config.json'); console.log('Project:', c.projectName, '| Engine:', c.autoFix?.narrative?.engine)"
# Expected: Project: context-ledger | Engine: api

# Verify ARCHITECTURE.md exists
cat docs/ARCHITECTURE.md | head -3
# Expected: # context-ledger Architecture

# Verify generated inventories exist
ls docs/_generated/ 2>/dev/null || echo "No generated docs yet (OK if scanPaths don't match)"

# Verify hooks are installed
cat .husky/pre-commit 2>/dev/null | head -5
# Expected: Shows agent-guard hook line

# Verify CLAUDE.md was created with standing instructions
cat CLAUDE.md | head -10
# Expected: Shows project context and doc maintenance rules
```

**STOP AND REPORT**: Confirm agent-guard is configured. Commit:
```bash
git add -A
git commit -m "chore: configure agent-guard for context-ledger"
```

---

## PHASE 3: Agents and Skills

### Context
Adapt the dashboard project's agents and skills for context-ledger's codebase. These are NOT the same as the dashboard agents — they need to understand a Node.js CLI/MCP project, not a Next.js dashboard.

### Step 3.1: Create adapted agents

**Claude Code prompt:**
```
Create the following agent definition files in C:\Users\russe\Documents\context-ledger\.claude\agents\

File: code-inspector.md
---
name: code-inspector
description: Read-only codebase investigation for context-ledger. Traces TypeScript types, module boundaries, export surfaces, and construction sites. Never modifies files.
tools: Read, Grep, Glob, Bash
model: sonnet
permissionMode: plan
---

You are a code inspector for a Node.js CLI + MCP server application (context-ledger).

## Rules
- NEVER modify any files. Read-only investigation only.
- Report findings as structured facts: file path, line number, relevant code snippet.
- When investigating TypeScript types, trace the full chain: interface → all construction sites → all consumers.
- Check BOTH the type definition AND every place that constructs objects of that type.

## Architecture Context
- Entry points: src/cli.ts (CLI), src/index.ts (MCP server), src/setup.ts (wizard)
- Event types: src/ledger/events.ts (DecisionRecord, TransitionEvent)
- Event fold: src/ledger/fold.ts (computes current state from event log)
- Inbox: src/ledger/inbox.ts (structured queue with lifecycle)
- Capture: src/capture/ (post-commit hook logic, classification)
- Retrieval: src/retrieval/ (query_decisions, scope derivation, decision packs)
- MCP tools: src/mcp/ (read tools and write tools registered with MCP SDK)
- Config: src/config.ts (default config, scope mappings, hint mappings)
- Storage: JSONL files (.context-ledger/ledger.jsonl, .context-ledger/inbox.jsonl)
- Zero runtime dependencies except @clack/prompts (setup wizard only)
- All imports use .js extensions (Node16 module resolution)

---

File: pattern-finder.md
---
name: pattern-finder
description: Finds implementation patterns in existing code. Traces data flow through event sourcing, MCP tool registration, CLI command handling, and config resolution.
tools: Read, Grep, Glob, Bash
model: sonnet
permissionMode: plan
---

You are a pattern analyst for a Node.js MCP server + CLI tool. Your job is to find and document existing implementation patterns so new features follow them consistently.

## Rules
- NEVER modify files. Read-only.
- When asked about a pattern, trace the FULL flow: event creation → JSONL append → fold logic → MCP query → response formatting
- Document each pattern as: Entry Point → Data Flow → Key Files → Code Snippets
- Pay special attention to:
  - Event schema consistency (all events must have type, id, created)
  - JSONL append patterns (always trailing newline, never mutate existing lines)
  - MCP tool registration patterns (tool name, schema, annotations, handler)
  - Config resolution order (defaults → config file → CLI args)
  - Error handling patterns (MCP returns structured errors, CLI prints to stderr)
- Flag any inconsistencies between files that should follow the same pattern

---

File: dependency-mapper.md
---
name: dependency-mapper
description: Maps the blast radius of proposed changes. Identifies imports, exports, consumers, and module boundaries so refactors stay non-breaking.
tools: Read, Grep, Glob, Bash
model: sonnet
permissionMode: plan
---

You are the Dependency Mapper for context-ledger, a Node.js CLI + MCP server.

## Rules
- NEVER modify any files. Read-only investigation only.
- Report findings as structured facts: file path, line number, relevant code snippet.

## Architecture Context
- ES modules with .js import extensions (Node16 resolution)
- Path alias: none (direct relative imports)
- Barrel files: src/ledger/index.ts, src/capture/index.ts, src/retrieval/index.ts, src/mcp/index.ts
- Entry points: src/cli.ts, src/index.ts (MCP), src/setup.ts
- MCP SDK: tool registrations in src/mcp/ — changes ripple into Claude Code behavior
- Config: src/config.ts — changes affect hook classification, scope derivation, and retrieval
- Events: src/ledger/events.ts — type changes affect fold, inbox, capture, retrieval, and all MCP tools

## Output goals
Your findings must help an orchestrator answer:
1. What can change safely?
2. What types or interfaces have wide blast radius?
3. Which modules must be updated together?
4. Where are the barrel file boundaries?
```

### Step 3.2: Create adapted skills

**Claude Code prompt:**
```
Create skill directories and files in C:\Users\russe\Documents\context-ledger\.claude\skills\

mkdir -p .claude/skills/build-guide
mkdir -p .claude/skills/new-feature

File: .claude/skills/build-guide/SKILL.md
---
name: build-guide
description: "Build an agentic implementation guide from exploration results. Creates a phased, validation-gated guide for context-ledger features."
---

# Build Agentic Implementation Guide — context-ledger

You are building an implementation guide from completed exploration results. The guide must be executable by a single Claude Code agent working phase-by-phase with human checkpoints.

## Prerequisites
Verify these exploration files exist:
- exploration-results.md
- code-inspector-findings.md
- pattern-finder-findings.md

Read ALL of them.

## Reference Document
The design spec is the single source of truth: context-ledger-design-v2.md
All event schemas, lifecycle rules, retrieval contracts, and MCP tool interfaces are defined there.

## Guide Structure
Create agentic_implementation_guide.md with:

### Standard Phase Order

**Phase 1: Blocking Prerequisites**
- Any infrastructure that must exist before feature code

**Phase 2: Type Definitions**
- Update TypeScript interfaces in src/ledger/events.ts or relevant type files
- This INTENTIONALLY breaks the build — errors become the checklist
- Validation gate: COUNT errors and list which files have them

**Phase 3: Core Logic**
- Event handling, fold logic, classification, scope derivation
- Whatever the feature's core algorithm is

**Phase 4: MCP Tool Integration**
- Register or update MCP tools in src/mcp/
- Wire up to core logic from Phase 3

**Phase 5: CLI Integration**
- Wire feature into src/cli.ts commands if applicable

**Phase 6: Documentation Sync**
Run: npx agent-guard sync
Review changes. Stage if correct.

**Phase 7: Validation**
- npm run build must pass with ZERO errors
- Smoke test if applicable
- Manual verification steps

### Critical Rules
1. Every construction site must be covered.
2. Validation gates must have concrete bash commands.
3. Import merges, not additions.
4. All events must conform to the schema in context-ledger-design-v2.md.
5. JSONL writes are always append-only with trailing newline.
6. MCP tools must include annotations (readOnlyHint, destructiveHint, openWorldHint).
7. Agent-guard sync before final validation.

---

File: .claude/skills/new-feature/SKILL.md
---
name: new-feature
description: "Kick off a new context-ledger feature with parallel exploration. Spawns agents for codebase inspection and pattern analysis."
---

# New Feature — Parallel Exploration

You are starting the exploration phase for a new context-ledger feature.

## Step 1: Understand the Feature
If not already clear from the user's request, ask:
- What capability is being added? (new event type, MCP tool, CLI command, capture trigger, retrieval enhancement)
- Which modules are affected? (ledger, capture, retrieval, mcp, cli, setup)
- Is this defined in context-ledger-design-v2.md or is it new scope?

## Step 2: Create Agent Team
Spawn an agent team with 2 teammates:

### Teammate 1: Code Inspector (use code-inspector agent)
Investigate:
- What TypeScript types/interfaces need changes?
- What files construct objects of those types?
- What MCP tools are affected?
- What CLI commands are affected?
- What barrel exports need updating?
Save findings to code-inspector-findings.md

### Teammate 2: Pattern Finder (use pattern-finder agent)
Investigate:
- How do existing similar features flow through the codebase?
- What patterns should this new feature follow?
- Are there inconsistencies to be aware of?
Save findings to pattern-finder-findings.md

## Step 3: Synthesize Results
Produce exploration-results.md containing:
1. Feature Summary
2. Files to Modify
3. Type Changes
4. Construction Site Inventory
5. Recommended Phase Order
6. Risks and Blockers
7. Documentation — must include npx agent-guard sync phase

## Step 4: Present to User
"Exploration complete. [N] files to modify. Run /build-guide to generate the implementation guide."
```

### PHASE 3 — VALIDATION GATE

```bash
cd C:\Users\russe\Documents\context-ledger

# Verify agents exist
ls .claude/agents/
# Expected: code-inspector.md  dependency-mapper.md  pattern-finder.md

# Verify skills exist
ls .claude/skills/build-guide/SKILL.md .claude/skills/new-feature/SKILL.md
# Expected: Both files exist

# Verify agent definitions have correct frontmatter
head -5 .claude/agents/code-inspector.md
# Expected: --- name: code-inspector ...

head -5 .claude/agents/pattern-finder.md
# Expected: --- name: pattern-finder ...
```

**STOP AND REPORT**: Confirm agents and skills are created. Commit:
```bash
git add -A
git commit -m "chore: add agents and skills adapted for context-ledger"
```

---

## PHASE 4: Slash Commands

### Context
Create the Claude Code slash commands that orchestrate the build workflow. These are adapted from the dashboard project but tailored for building an npm package, not a Next.js dashboard.

### Step 4.1: Create /auto-feature command

**Claude Code prompt:**
```
Create C:\Users\russe\Documents\context-ledger\.claude\commands\auto-feature.md with the following content. This is the primary orchestration command for building context-ledger features:

# /auto-feature — Automated Feature Planning Pipeline

You are an orchestrator. Your job is to take a feature request, run a full exploration and planning pipeline, get adversarial review, and produce a refined implementation guide ready for execution. You do NOT execute the guide — that happens in a fresh context after this command completes.

**Feature request:** $ARGUMENTS

---

## RULES

1. Execute phases in strict order. Do not skip phases.
2. Write all artifacts to disk in the project root. Later phases read them from disk.
3. Print a progress header at the start of each phase.
4. Do not ask the user anything until the Human Input Gate in Phase 4.
5. If a phase fails, report clearly and stop.
6. The design spec (context-ledger-design-v2.md) is the single source of truth for all event schemas, lifecycle rules, retrieval contracts, and MCP tool interfaces.

---

## PHASE 1: EXPLORATION

Spawn an agent team with 2 teammates to investigate in parallel:

### Teammate 1: Code Inspector (agent: code-inspector)

Task: "Investigate the codebase for the following feature: $ARGUMENTS

Find:
- Every TypeScript type/interface that needs new fields or new types
- Every file that CONSTRUCTS objects of those types (construction sites)
- Every MCP tool registration that needs changes
- Every CLI command handler that needs changes
- Every barrel export (index.ts) that needs updating
- The event schema in src/ledger/events.ts and how the fold in src/ledger/fold.ts processes it

Save findings to code-inspector-findings.md in the project root."

### Teammate 2: Pattern Finder (agent: pattern-finder)

Task: "Find implementation patterns for the following feature: $ARGUMENTS

Trace how existing similar features flow:
- Event creation → JSONL append → fold → MCP query → response
- CLI command parsing → action → output
- Config resolution → runtime behavior
- Error handling and edge cases

Save findings to pattern-finder-findings.md in the project root."

### Synthesis

Once both teammates complete, read both findings files and produce exploration-results.md containing:

1. **Pre-Flight Summary** — 5-10 line summary. Print to console.
2. **Files to Modify** — Complete list with file paths and what changes
3. **Type Changes** — Exact fields/types to add or modify
4. **Construction Site Inventory** — Every code location that constructs modified types
5. **Recommended Phase Order** — Based on dependencies
6. **Risks and Blockers** — Missing prerequisites, schema questions, consistency issues
7. **Design Spec Compliance** — Does this feature match what context-ledger-design-v2.md specifies? Flag any deviations.

Proceed immediately to Phase 2.

---

## PHASE 2: BUILD GUIDE

Follow the build-guide skill (.claude/skills/build-guide/SKILL.md).

Read all exploration documents and the design spec (context-ledger-design-v2.md). Produce agentic_implementation_guide.md.

Every phase must have:
- A validation gate with concrete bash/grep commands
- A STOP AND REPORT checkpoint
- Exact file paths and exact type names from code-inspector findings

**context-ledger-specific rules:**
- All events must conform to the schema in context-ledger-design-v2.md
- JSONL writes are always append-only with trailing newline
- MCP tools include annotations (readOnlyHint, destructiveHint, openWorldHint)
- All imports use .js extensions (Node16 module resolution)
- Zero runtime dependencies except @clack/prompts in setup.ts
- Import merges, not additions — never add a second import from the same module
- Agent-guard sync before final validation

Proceed immediately to Phase 3.

---

## PHASE 3: ADVERSARIAL COUNCIL REVIEW

Send the implementation guide and exploration results to OpenAI and Gemini for adversarial review using the council-mcp tools. Send separate prompts — do NOT use ask_all.

### Prepare the payload
Read and concatenate:
- context-ledger-design-v2.md (the spec — this is what the guide should implement)
- exploration-results.md
- agentic_implementation_guide.md

### Send to OpenAI
Use ask_openai with reasoning_effort: "high".

System prompt: "You are a senior TypeScript engineer reviewing an implementation plan for a Node.js MCP server + CLI tool. The project uses event-sourced JSONL storage. Your job is adversarial — find what will break."

Prompt: Include the full payload, then ask OpenAI to focus on:
- Type safety: Are ALL construction sites covered?
- Event schema correctness: Do events match the spec exactly?
- MCP tool contracts: Do tool parameters, return types, and error handling match the spec?
- JSONL integrity: Is append-only respected everywhere? Trailing newlines?
- Phase ordering: Can each phase execute given what prior phases produce?
- Missing steps: Anything implied but not spelled out?

Required response format: CRITICAL / SHOULD FIX / DESIGN QUESTIONS / SUGGESTED IMPROVEMENTS

### Send to Gemini
Use ask_gemini.

System prompt: "You are a senior developer experience engineer reviewing an implementation plan for a developer tool. Your job is to find usability problems, edge cases, and spec deviations."

Prompt: Include the full payload, then ask Gemini to focus on:
- Spec compliance: Does the implementation match context-ledger-design-v2.md exactly?
- Edge cases: What happens with malformed JSONL, missing config, empty inbox, circular supersedence?
- Developer experience: Will the CLI feel good to use? Are error messages helpful?
- Integration: Will this work correctly with agent-guard and council-mcp?
- Retrieval quality: Will query_decisions actually return relevant results for real queries?

Same required response format.

### Cross-Checks
After receiving both responses, run these checks yourself:
1. Every event type in the guide matches the schema in context-ledger-design-v2.md
2. Every MCP tool matches the spec's parameter list and return format
3. Lifecycle state machine transitions are all legal per the spec
4. Auto-promotion threshold (>= 0.7) is enforced correctly
5. Token budgeting is implemented on decision packs

### Write council-feedback.md
Merge, deduplicate, and write to council-feedback.md.

Proceed immediately to Phase 4.

---

## PHASE 4: SELF-TRIAGE AND REFINEMENT

Read council-feedback.md and triage EVERY item:

### Bucket 1 — APPLY AUTONOMOUSLY
- Wrong type names or file paths → fix to match codebase
- Missing construction sites → add to guide
- Event schema deviations from spec → fix to match spec
- Missing error handling → add
- Phase ordering errors → reorder
- Missing validation gates → add

### Bucket 2 — NEEDS HUMAN INPUT
- Implementation approach choices where spec allows flexibility
- UX decisions for CLI output formatting
- Config default values
- Feature scope decisions

### Bucket 3 — NOTE BUT DON'T APPLY
- Scope expansions beyond what the spec defines
- Alternative architectures where current approach matches spec
- Performance optimizations not needed at current scale

Apply Bucket 1 fixes. Append Refinement Log.

### Human Input Gate
IF Bucket 2 is empty: print ready message with execution instructions.
IF Bucket 2 has items: print questions and STOP. WAIT FOR USER.

When user responds, apply answers and print ready message:
"Run /compact to clear context, then: Execute agentic_implementation_guide.md phase by phase."

---

## FILES PRODUCED

| File | Phase | Purpose |
|------|-------|---------|
| code-inspector-findings.md | 1 | Types, construction sites, module dependencies |
| pattern-finder-findings.md | 1 | Established patterns for events, MCP tools, CLI |
| exploration-results.md | 1 | Synthesized summary |
| agentic_implementation_guide.md | 2 (created), 4 (refined) | Phased execution plan |
| council-feedback.md | 3 | GPT + Gemini adversarial review |
| triage-results.md | 4 | Categorized triage |

---

## FAILURE MODES

- **MCP tool timeout (council):** Retry once. If both fail for a provider, proceed with whichever responded.
- **Agent teammate failure:** Report which one failed and what it couldn't do. Do not proceed.

---

## BEGIN

Start Phase 1 now. The feature to build is: **$ARGUMENTS**
```

### Step 4.2: Create /council command

**Claude Code prompt:**
```
Create C:\Users\russe\Documents\context-ledger\.claude\commands\council.md

Use the setup-council wizard approach — but since we know exactly what this project is, generate a tailored council command directly.

The command should:
1. Verify council-mcp MCP server is available (check for ask_openai, ask_gemini tools)
2. Find and read: agentic_implementation_guide.md, exploration-results.md, code-inspector-findings.md, pattern-finder-findings.md, and context-ledger-design-v2.md
3. Send to OpenAI (reasoning_effort: high) focused on: type safety, event schema correctness, MCP tool contracts, JSONL integrity, construction sites
4. Send to Gemini focused on: spec compliance, edge cases, developer experience, integration with agent-guard and council-mcp, retrieval quality
5. Both require CRITICAL / SHOULD FIX / DESIGN QUESTIONS response format
6. Synthesize into council-feedback.md
7. Present critical issues and design questions to user
8. Tell user to run /refine after answering

Model the structure on the dashboard council.md but replace all dashboard/BigQuery references with context-ledger/JSONL/MCP references. Include the full document text in payloads — never summarize.
```

### Step 4.3: Create /refine command

**Claude Code prompt:**
```
Create C:\Users\russe\Documents\context-ledger\.claude\commands\refine.md

Model on the dashboard refine.md but adapted for context-ledger. The command should:
1. Read the implementation plan + council-feedback.md + conversation history + context-ledger-design-v2.md
2. Triage into three buckets:
   - Apply Immediately: wrong types, missing construction sites, event schema deviations, missing error handling, pattern drift
   - Apply Based on User's Answers: UX choices, config defaults, scope decisions
   - Note but Don't Apply: scope expansions, alternative approaches
3. context-ledger-specific rules:
   - Event schemas must match context-ledger-design-v2.md exactly
   - JSONL is always append-only with trailing newline
   - MCP tools must include annotations
   - Lifecycle transitions must follow the state machine in the spec
   - All imports use .js extensions
4. Edit the plan directly, update validation gates, append Refinement Log
5. Self-review for consistency
6. Report and stop — do not execute
```

### Step 4.4: Create /quick-update command

**Claude Code prompt:**
```
Create C:\Users\russe\Documents\context-ledger\.claude\commands\quick-update.md

Adapted from the dashboard quick-update for small context-ledger changes (1-5 files). The command should:
1. Read context-ledger-design-v2.md for spec reference
2. Scope the change — if > 5 files or needs new event types, recommend /auto-feature
3. Investigate only affected files
4. Produce an inline change plan (not a separate file)
5. Confirm before executing
6. Run npx agent-guard sync after changes
7. Suggest git add and commit message

Good for: adding a field to an event type, fixing a CLI output format, tweaking config defaults, updating an MCP tool parameter
Not for: new event types, new MCP tools, new CLI commands, anything requiring council review
```

### PHASE 4 — VALIDATION GATE

```bash
cd C:\Users\russe\Documents\context-ledger

# Verify all commands exist
ls .claude/commands/
# Expected: auto-feature.md  council.md  quick-update.md  refine.md

# Verify commands have content (not empty)
wc -l .claude/commands/*.md
# Expected: Each file should be 50+ lines

# Verify no dashboard-specific references leaked in
grep -rl "BigQuery\|dashboard\|Savvy\|SGA\|drill-down\|vw_funnel" .claude/commands/ || echo "Clean — no dashboard references"
# Expected: Clean — no dashboard references

grep -rl "BigQuery\|dashboard\|Savvy\|SGA\|drill-down\|vw_funnel" .claude/agents/ || echo "Clean — no dashboard references"
# Expected: Clean — no dashboard references
```

**STOP AND REPORT**: Confirm all slash commands are created and clean. Commit:
```bash
git add -A
git commit -m "chore: add slash commands for context-ledger development workflow"
```

---

## PHASE 5: Standing Instructions and Design Spec

### Context
Set up CLAUDE.md with project-specific standing instructions and load the design spec as the authoritative reference document.

### Step 5.1: Copy the design spec

**Claude Code prompt:**
```
Copy the latest context-ledger design spec into the project:
cp "C:\Users\russe\Documents\Dashboard\context-ledger-design-v2.md" "C:\Users\russe\Documents\context-ledger\context-ledger-design-v2.md"

Verify it's v2.3 (or whatever the latest version is):
head -1 context-ledger-design-v2.md
# Should show: # context-ledger: Design Document v2.3
```

### Step 5.2: Create comprehensive CLAUDE.md

**Claude Code prompt:**
```
Read C:\Users\russe\Documents\context-ledger\CLAUDE.md (agent-guard may have created a starter version). 
Replace or merge with the following comprehensive standing instructions. If agent-guard already wrote 
a Documentation Maintenance section, keep that and add the sections below AFTER it.

# CLAUDE.md — context-ledger

## Project Overview
context-ledger is a decision capture and retrieval system for AI-assisted development.
It captures the "why" behind architectural choices and makes them retrievable via MCP.

NPM package name: context-ledger
GitHub: https://github.com/russellmoss/context-ledger

## Tech Stack
- Node.js 18+ (ES modules, "type": "module")
- TypeScript (strict mode, Node16 module resolution)
- MCP SDK (@modelcontextprotocol/sdk)
- @clack/prompts (setup wizard only)
- Storage: local JSONL (event-sourced, append-only)
- Zero other runtime dependencies

## Critical Rules
- All imports use .js extensions (Node16 resolution)
- JSONL writes are ALWAYS append-only with trailing newline — never mutate existing lines
- All events must conform to the schema in context-ledger-design-v2.md
- MCP tools must include annotations (readOnlyHint, destructiveHint, openWorldHint)
- No console.log in src/index.ts — stdout is reserved for MCP JSON-RPC. Use console.error for diagnostics.
- The post-commit hook must execute in under 100ms. Zero LLM calls. Zero network calls.
- Lifecycle transitions must follow the state machine: superseded is terminal, abandoned/expired can reopen, no cycles.
- Auto-promotion threshold: only records with retrieval_weight >= 0.7 and durability = "precedent" can drive autonomous behavior.

## Design Spec
The authoritative design document is: context-ledger-design-v2.md (in project root)
It contains all event schemas, lifecycle rules, retrieval contracts, MCP tool interfaces,
and 47 traced design decisions from 4 rounds of adversarial review.
ALWAYS check the design spec before implementing new features.

## Development Workflow
- /auto-feature — full exploration + planning + council review pipeline
- /council — send implementation plan to GPT + Gemini for adversarial review
- /refine — apply council feedback to implementation plan
- /quick-update — lightweight changes (1-5 files, no council review needed)
- Always run npx agent-guard sync after code changes pass build
- Always execute implementation guides in a FRESH Claude Code instance to avoid context contamination

## Ecosystem Integration
- agent-guard owns: current factual state (inventories, doc sync, session context)
- context-ledger owns: durable rationale (decisions, precedents, abandoned approaches)
- council-of-models-mcp owns: adversarial review (cross-LLM validation)
- Loading order: agent-guard factual docs first, then context-ledger decision packs

## Module Boundaries
- src/ledger/ — Event types, fold logic, inbox management, validation. This is the core data model.
- src/capture/ — Post-commit hook, change classification. Instantaneous, deterministic.
- src/retrieval/ — query_decisions, scope derivation, decision packs. File-path-first.
- src/mcp/ — MCP tool registrations. Read tools and write tools with idempotency.
- src/cli.ts — CLI commands. User-facing output.
- src/setup.ts — Interactive wizard. @clack/prompts only.
- src/config.ts — Configuration defaults. Single source of truth for defaults.
```

### Step 5.3: Create example slash command templates

**Claude Code prompt:**
```
Create the example slash command templates that ship with the npm package:

File: C:\Users\russe\Documents\context-ledger\examples\claude-commands\decision.md

# /decision — Capture an Architectural Decision

You are capturing an architectural decision for the project's context-ledger.

**Decision:** $ARGUMENTS

Ask the developer 2-3 targeted questions:
1. What drove this change?
2. What did you try first or what alternatives did you consider? (if switching away from something)
3. What would make you revisit this decision?

Then use the context-ledger MCP tool propose_decision to write a decision record to the inbox
for confirmation. Include:
- summary and decision text from the conversation
- alternatives_considered with why_rejected for each
- rationale from the developer's answers
- revisit_conditions from question 3
- Appropriate scope (derive from affected files)
- Appropriate decision_kind (use recommended vocabulary if applicable)
- durability: precedent (unless the developer indicates it's temporary)

---

File: C:\Users\russe\Documents\context-ledger\examples\claude-commands\check-decisions.md

# /check-decisions — Query the Decision Ledger

Query the context-ledger for decisions relevant to the current task.

**Query:** $ARGUMENTS

Use the context-ledger MCP tool query_decisions with:
- If the user mentioned specific files, use file_path as the primary parameter
- If the user described a concept, use query as the parameter
- Default: include_superseded false, include_unreviewed false

Present the decision pack to the user:
- Active precedents (with retrieval weight)
- Abandoned approaches (with pain points — these are things NOT to repeat)
- Decision gaps (scopes with no precedent — flag these as needing human input)
- Any pending inbox items for the relevant scope
```

### PHASE 5 — VALIDATION GATE

```bash
cd C:\Users\russe\Documents\context-ledger

# Verify design spec is present and correct version
head -1 context-ledger-design-v2.md
# Expected: # context-ledger: Design Document v2.3

# Verify CLAUDE.md has all required sections
grep -c "Critical Rules\|Design Spec\|Development Workflow\|Ecosystem Integration\|Module Boundaries" CLAUDE.md
# Expected: 5 (all sections present)

# Verify no console.log rule is documented
grep "console.log" CLAUDE.md
# Expected: Shows the "No console.log in src/index.ts" rule

# Verify examples exist
ls examples/claude-commands/
# Expected: decision.md  check-decisions.md

# Verify no dashboard references in CLAUDE.md
grep -c "BigQuery\|dashboard\|Savvy\|SGA" CLAUDE.md
# Expected: 0
```

**STOP AND REPORT**: Confirm standing instructions and design spec are in place. Commit:
```bash
git add -A
git commit -m "chore: add CLAUDE.md standing instructions, design spec, and example commands"
```

---

## PHASE 6: Council MCP Verification

### Context
Verify that council-of-models-mcp is registered and working so /auto-feature can use it during development.

### Step 6.1: Verify MCP registration

**Claude Code prompt:**
```
Run: claude mcp list

Look for council-mcp in the output. If it's not there, register it:

If council-mcp is installed globally:
claude mcp add --scope user council-mcp -- council-mcp

If using the cloned repo:
claude mcp add --scope user council-mcp -- node "C:\Users\russe\Documents\Council_of_models_mcp\dist\index.js"
```

### Step 6.2: Smoke test providers

**Claude Code prompt:**
```
Use ask_openai to respond with exactly: "OK"
Use ask_gemini to respond with exactly: "OK"

If either fails, check:
1. API keys are set (check .env in the project root AND shell environment)
2. Network connectivity
3. API quota
```

### PHASE 6 — VALIDATION GATE

```bash
# Verify MCP server is registered
claude mcp list 2>&1 | grep "council-mcp"
# Expected: council-mcp: ... Connected (or similar)

# If in a Claude Code session, the smoke test above should have returned "OK" from both providers
```

**STOP AND REPORT**: Confirm council-mcp is registered and both providers respond. No commit needed.

---

## PHASE 7: Final Verification and README

### Step 7.1: Create initial README

**Claude Code prompt:**
```
Create C:\Users\russe\Documents\context-ledger\README.md:

# context-ledger

Decision capture and retrieval system for AI-assisted development.

Captures the *why* behind architectural choices and makes that reasoning retrievable 
via MCP so AI agents stop repeating mistakes and stop asking the same design questions 
on every feature.

## Status: Pre-release (building)

This package is under active development. See context-ledger-design-v2.md for the 
full design specification.

## Ecosystem

context-ledger is the third tool in a composable ecosystem:

- **[agent-guard](https://www.npmjs.com/package/@mossrussell/agent-guard)** — keeps the *what* accurate
- **context-ledger** — keeps the *why* accessible  
- **[council-of-models-mcp](https://www.npmjs.com/package/council-of-models-mcp)** — keeps the *review* adversarial

## License

ISC
```

### Step 7.2: Run full infrastructure check

**Claude Code prompt:**
```
Run a comprehensive check of the entire project infrastructure:

1. npm run build (should succeed — placeholder files only)
2. git log --oneline (should show 4 commits from phases 1-5)
3. ls -la .claude/commands/ (should show 4 command files)
4. ls -la .claude/agents/ (should show 3 agent files)
5. ls -la .claude/skills/*/SKILL.md (should show 2 skill files)
6. cat CLAUDE.md | wc -l (should be 50+ lines)
7. head -1 context-ledger-design-v2.md (should show v2.3)
8. cat .env | grep -c "KEY" (should show 3)
9. npx agent-guard check --check-only (should run without errors)
10. Verify council-mcp tools are available (ask_openai, ask_gemini, ask_all visible)
```

### PHASE 7 — VALIDATION GATE

```bash
cd C:\Users\russe\Documents\context-ledger

echo "=== Project Structure ==="
find . -name "*.md" -not -path "./node_modules/*" -not -path "./dist/*" | sort

echo "=== Package Info ==="
node -e "const p=require('./package.json'); console.log(p.name, p.version)"

echo "=== TypeScript ==="
npx tsc --noEmit 2>&1 | tail -3

echo "=== Git Status ==="
git log --oneline

echo "=== Agent Infrastructure ==="
echo "Commands: $(ls .claude/commands/ | wc -l)"
echo "Agents: $(ls .claude/agents/ | wc -l)"  
echo "Skills: $(find .claude/skills -name SKILL.md | wc -l)"

echo "=== Design Spec ==="
head -1 context-ledger-design-v2.md
```

Expected output summary:
- Package: context-ledger 0.1.0
- TypeScript: no errors
- Git: 4-5 clean commits
- Commands: 4 (auto-feature, council, refine, quick-update)
- Agents: 3 (code-inspector, pattern-finder, dependency-mapper)
- Skills: 2 (build-guide, new-feature)
- Design spec: v2.3

**STOP AND REPORT**: All infrastructure is in place. Final commit:
```bash
git add -A
git commit -m "chore: complete pre-build infrastructure setup"
```

---

## What's Next

The infrastructure is ready. You now have:

- A properly scaffolded TypeScript project with the right package.json and tsconfig
- agent-guard keeping docs in sync from commit #1
- council-of-models-mcp ready for adversarial review
- Agents adapted for a Node.js MCP server project (not a dashboard)
- Slash commands tailored for context-ledger development
- Standing instructions in CLAUDE.md with all critical rules
- The v2.3 design spec as the single source of truth

**To start building context-ledger:**

```
/auto-feature "Implement the core event-sourced ledger: DecisionRecord and TransitionEvent types in src/ledger/events.ts, the append-only JSONL writer, and the event fold logic in src/ledger/fold.ts that computes current state (active/superseded/abandoned/expired) from the event log. Follow the exact schemas and lifecycle state machine defined in context-ledger-design-v2.md."
```

That command will explore the (mostly empty) codebase, produce a phased implementation guide, send it to GPT and Gemini for review, and give you a refined plan to execute in a fresh instance.

Build the core loop first. Ship it. Then layer on capture, retrieval, MCP tools, CLI, and wizard.
