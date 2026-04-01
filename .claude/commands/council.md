# /council — Adversarial Council Review for context-ledger

You are sending an implementation plan to GPT and Gemini for adversarial review. This ensures the plan is correct, complete, and spec-compliant before execution.

**Additional context from user:** $ARGUMENTS

---

## RULES

1. Send separate prompts to each provider — do NOT use ask_all.
2. Include full document text in payloads — never summarize.
3. Both providers must use the same response format.
4. If a provider times out, retry once. If it fails again, proceed with whichever responded.

---

## STEP 1: VERIFY PREREQUISITES

Check that the council-mcp MCP server is available by confirming these tools exist:
- ask_openai
- ask_gemini

If not available, stop and tell the user to register council-mcp:
```
claude mcp add --scope user council-mcp -- node "C:\Users\russe\Documents\Council_of_models_mcp\dist\index.js"
```

---

## STEP 2: GATHER DOCUMENTS

Find and read ALL of the following files from the project root:
- context-ledger-design-v2.md (the authoritative design spec)
- agentic_implementation_guide.md (the plan to review)
- exploration-results.md (context from codebase investigation)
- code-inspector-findings.md (type and construction site analysis)
- pattern-finder-findings.md (established patterns)

If agentic_implementation_guide.md doesn't exist, stop and tell the user to run /auto-feature first.

Concatenate all documents into a single payload.

---

## STEP 3: SEND TO OPENAI

Use ask_openai with reasoning_effort: "high".

System prompt:
"You are a senior TypeScript engineer reviewing an implementation plan for a Node.js MCP server + CLI tool called context-ledger. The project uses event-sourced JSONL storage with append-only semantics. Your job is adversarial — find what will break."

Prompt: Include the full payload, then:

"Review this implementation plan against the design spec. Focus on:

1. **Type Safety**: Are ALL construction sites covered? Will the build pass after each phase?
2. **Event Schema Correctness**: Do all event types match the schemas in context-ledger-design-v2.md exactly? Check field names, types, optionality.
3. **MCP Tool Contracts**: Do tool parameters, return types, annotations (readOnlyHint, destructiveHint, openWorldHint), and error handling match the spec?
4. **JSONL Integrity**: Is append-only respected everywhere? Trailing newlines on every write? No mutation of existing lines?
5. **Lifecycle State Machine**: Are all transitions legal? Is superseded terminal? Can abandoned/expired reopen? No cycles?
6. **Construction Sites**: Every place that creates a DecisionRecord, TransitionEvent, or InboxItem — are they all listed and updated?
7. **Phase Ordering**: Can each phase execute successfully given only what prior phases produce?
8. **Missing Steps**: Anything implied by the spec but not spelled out in the guide?

Required response format:
### CRITICAL (will break the build or corrupt data)
### SHOULD FIX (correctness issues that won't immediately break)
### DESIGN QUESTIONS (ambiguities in the spec that need human decision)
### SUGGESTED IMPROVEMENTS (nice-to-have, not blocking)"

---

## STEP 4: SEND TO GEMINI

Use ask_gemini.

System prompt:
"You are a senior developer experience engineer reviewing an implementation plan for a developer tool called context-ledger. It's a decision capture and retrieval system that integrates with AI coding assistants via MCP. Your job is to find usability problems, edge cases, and spec deviations."

Prompt: Include the full payload, then:

"Review this implementation plan against the design spec. Focus on:

1. **Spec Compliance**: Does every feature in the implementation match context-ledger-design-v2.md exactly? Flag any deviations, additions, or omissions.
2. **Edge Cases**: What happens with malformed JSONL? Missing config file? Empty inbox? Circular supersedence chains? Zero decisions matching a query? Token budget exceeded?
3. **Developer Experience**: Will the CLI feel good to use? Are error messages helpful and actionable? Does the setup wizard cover all necessary configuration?
4. **Integration**: Will this work correctly alongside agent-guard (doc sync) and council-mcp (adversarial review)? Any conflicts in MCP tool naming or file access?
5. **Retrieval Quality**: Will query_decisions actually return relevant results for real developer queries? Is scope derivation robust for edge-case file paths?
6. **Auto-promotion Safety**: Is the >= 0.7 retrieval_weight threshold enforced correctly? Can a decision accidentally get promoted without meeting criteria?

Required response format:
### CRITICAL (will break the build or corrupt data)
### SHOULD FIX (correctness issues that won't immediately break)
### DESIGN QUESTIONS (ambiguities in the spec that need human decision)
### SUGGESTED IMPROVEMENTS (nice-to-have, not blocking)"

---

## STEP 5: SYNTHESIZE

After receiving both responses:

1. **Cross-check** both reviews against each other — note agreements and contradictions
2. **Verify yourself**:
   - Every event type in the guide matches the schema in context-ledger-design-v2.md
   - Every MCP tool matches the spec's parameter list and return format
   - Lifecycle state machine transitions are all legal per the spec
   - Auto-promotion threshold (>= 0.7) is enforced correctly
   - Token budgeting is implemented on decision packs
3. **Merge and deduplicate** into council-feedback.md with sections:
   - CRITICAL issues (from either provider)
   - SHOULD FIX issues (deduplicated)
   - DESIGN QUESTIONS (deduplicated)
   - SUGGESTED IMPROVEMENTS (deduplicated)
   - Source attribution for each item (OpenAI / Gemini / Both / Self-check)

Write council-feedback.md to the project root.

---

## STEP 6: PRESENT TO USER

Print a summary:
- Number of CRITICAL issues
- Number of SHOULD FIX issues
- Number of DESIGN QUESTIONS requiring human input
- Top 3 most important findings

Tell the user: "Run **/refine** to apply council feedback to the implementation guide."
