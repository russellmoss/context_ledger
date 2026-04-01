# /refine — Apply Council Feedback to Implementation Guide

You are refining an implementation guide based on adversarial council feedback. Your job is to triage every piece of feedback, apply what you can autonomously, ask the user about decisions that need human input, and produce a clean, ready-to-execute guide.

**Additional context from user:** $ARGUMENTS

---

## RULES

1. Read ALL source documents before triaging.
2. Edit the implementation guide directly — do not create a separate file.
3. Every edit must maintain the guide's phase structure and validation gates.
4. The design spec (context-ledger-design-v2.md) is the single source of truth.
5. Do NOT execute the guide — refinement only.

---

## STEP 1: READ ALL DOCUMENTS

Read from the project root:
- agentic_implementation_guide.md (the plan to refine)
- council-feedback.md (the feedback to apply)
- context-ledger-design-v2.md (the authoritative spec)
- exploration-results.md (codebase context)

If any are missing, stop and tell the user which files are needed.

---

## STEP 2: TRIAGE EVERY ITEM

Go through council-feedback.md item by item. Categorize each into one of three buckets:

### Bucket 1 — APPLY IMMEDIATELY (autonomous fixes)
- Wrong type names or file paths → fix to match codebase
- Missing construction sites → add to the relevant phase
- Event schema deviations from spec → fix to match context-ledger-design-v2.md exactly
- Missing error handling → add to the relevant phase
- Phase ordering errors → reorder phases
- Missing validation gates → add concrete bash commands
- Pattern drift from established codebase patterns → align
- Missing .js import extensions → add
- Missing MCP tool annotations → add readOnlyHint, destructiveHint, openWorldHint
- JSONL append-only violations → fix to append-only with trailing newline

### Bucket 2 — NEEDS HUMAN INPUT (ask the user)
- Implementation approach choices where the spec allows flexibility
- UX decisions for CLI output formatting
- Config default values not specified in the design spec
- Feature scope decisions (include or defer?)
- Trade-offs between competing valid approaches

### Bucket 3 — NOTE BUT DON'T APPLY
- Scope expansions beyond what context-ledger-design-v2.md defines
- Alternative architectures where current approach already matches spec
- Performance optimizations not needed at current scale (< 10K decisions)
- Suggestions that would add runtime dependencies

---

## STEP 3: APPLY BUCKET 1

For each Bucket 1 item:
1. Edit agentic_implementation_guide.md directly
2. Update affected validation gates if the fix changes expected output
3. Ensure phase dependencies still hold after reordering

---

## STEP 4: SELF-REVIEW

After all Bucket 1 fixes, review the guide for internal consistency:
- Does each phase produce what the next phase needs?
- Are all TypeScript types from the spec accounted for?
- Do all validation gate commands actually test what they claim?
- Are there any new construction sites introduced by fixes that need coverage?
- Is agent-guard sync still in the penultimate phase?

---

## STEP 5: APPEND REFINEMENT LOG

Add a "Refinement Log" section at the bottom of agentic_implementation_guide.md:

```
## Refinement Log

### Applied (Bucket 1)
- [list each fix with source: OpenAI/Gemini/Both/Self-check]

### Deferred to User (Bucket 2)
- [list each question]

### Noted, Not Applied (Bucket 3)
- [list each item with reason for deferral]
```

Also write triage-results.md to the project root with the full categorized triage.

---

## STEP 6: PRESENT AND GATE

**IF Bucket 2 is empty:**
Print: "Refinement complete. No human decisions needed. The guide is ready to execute."
Print: "Run /compact to clear context, then: Execute agentic_implementation_guide.md phase by phase."

**IF Bucket 2 has items:**
Print each question clearly, numbered, with context about what the spec says and what the trade-offs are.
Print: "Please answer the questions above. I'll apply your answers and finalize the guide."

STOP. WAIT FOR USER RESPONSE.

When the user responds:
1. Apply their answers to agentic_implementation_guide.md
2. Update the Refinement Log
3. Print: "Guide finalized. Run /compact to clear context, then: Execute agentic_implementation_guide.md phase by phase."
