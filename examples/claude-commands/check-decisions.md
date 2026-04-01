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
