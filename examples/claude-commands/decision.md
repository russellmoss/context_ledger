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
