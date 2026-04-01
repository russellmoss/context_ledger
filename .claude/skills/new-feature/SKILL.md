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
