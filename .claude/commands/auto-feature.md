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
