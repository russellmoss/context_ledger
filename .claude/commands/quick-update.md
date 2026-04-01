# /quick-update — Lightweight Change for context-ledger

You are making a small, targeted change to context-ledger (1-5 files). This command skips the full exploration/council pipeline and goes straight to investigation → plan → execute.

**Change request:** $ARGUMENTS

---

## RULES

1. If the change touches > 5 files or requires new event types or new MCP tools, STOP and recommend /auto-feature instead.
2. Read the design spec first — even small changes must comply.
3. Confirm the plan with the user before executing.
4. Run agent-guard sync after changes.

---

## STEP 1: READ DESIGN SPEC

Read context-ledger-design-v2.md from the project root. Identify whether the requested change is defined in the spec or is a new addition.

---

## STEP 2: SCOPE THE CHANGE

Investigate only the files affected by this change:
- What files need modification?
- What types are affected?
- What construction sites need updating?

**Escalation check:** If any of these are true, stop and recommend /auto-feature:
- More than 5 files need changes
- A new event type needs to be defined in src/ledger/events.ts
- A new MCP tool needs to be registered in src/mcp/
- A new CLI command needs to be added to src/cli.ts
- The change affects the lifecycle state machine
- The change requires council review for correctness

---

## STEP 3: INLINE CHANGE PLAN

Present the change plan inline (not as a separate file):

```
## Change Plan: [brief description]

### Files to modify:
1. [file path] — [what changes]
2. ...

### Type changes:
- [type name]: [field changes]

### Validation:
- npm run build (must pass)
- [any specific checks]
```

---

## STEP 4: CONFIRM AND EXECUTE

Ask: "Proceed with this change plan?"

If confirmed:
1. Make the changes
2. Run: npx tsc --noEmit (verify build)
3. Run: npx agent-guard sync
4. Review any doc changes from agent-guard

---

## STEP 5: WRAP UP

Suggest a commit:
```
git add [specific files]
git commit -m "[suggested message]"
```

**Good for:** adding a field to an existing event type, fixing a CLI output format, tweaking config defaults, updating an MCP tool parameter, fixing a bug in fold logic.

**Not for:** new event types, new MCP tools, new CLI commands, anything requiring council review.
