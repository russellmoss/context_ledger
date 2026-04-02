# Exploration Results: Setup Wizard Implementation

Generated: 2026-04-01
Feature: Interactive setup wizard in src/setup.ts using @clack/prompts

---

## Pre-Flight Summary

The setup wizard is fully defined in context-ledger-design-v2.md (lines 807-842). `src/setup.ts` is a 3-line placeholder stub. `@clack/prompts ^1.2.0` is already declared as a runtime dependency and installed. The `context-ledger-setup` bin entry in package.json already points to `dist/setup.js`. Hook installation logic exists in `cli.ts installPostCommitHook()` (lines 400-475) but is private — the wizard needs its own version using @clack/prompts UI. No new event types, MCP tools, or lifecycle changes required. This is a UI-only module that reads/writes config and filesystem.

---

## Files to Modify

| File | Change Type | What Changes |
|------|-------------|-------------|
| `src/setup.ts` | **Full implementation** | Replace 3-line stub with complete 5-step wizard |
| `src/cli.ts` | **Minor update** | `handleSetup()` imports and delegates to `runSetupWizard()` from `./setup.js` |
| `package.json` | **Verify only** | bin entry `context-ledger-setup: dist/setup.js` already correct |

**Total: 2 files modified** (package.json only needs verification, not modification)

---

## Type Changes

No new types required. The wizard uses existing types:
- `LedgerConfig` from `src/config.ts` (for reading/writing config)
- `ScopeMapping` from `src/config.ts` (for scope_mappings values)
- `ScopeType` from `src/ledger/events.ts` (for scope mapping type field)
- `DecisionPack` from `src/retrieval/packs.ts` (for first-run demo display)
- `InboxItem` from `src/ledger/events.ts` (referenced in DecisionPack)

---

## Construction Site Inventory

### src/setup.ts (new file, full implementation)
- **Step 1**: Reads `package.json`, checks `fs.access` for `.claude/`, `agent-docs.config.json`, `.claude/settings.local.json`
- **Step 2**: Uses `readdir` to scan `src/` 2 levels deep. Constructs `ScopeMapping` objects for `config.capture.scope_mappings`. Constructs `feature_hint_mappings` entries. Writes via `writeFile(configPath(...), JSON.stringify(config, null, 2) + "\n")`
- **Step 3**: Replicates hook detection logic from `cli.ts installPostCommitHook()` but with @clack/prompts UI (confirm, spinner, log)
- **Step 4**: Reads CLAUDE.md or .cursorrules, checks for `"context-ledger"` marker, appends standing instructions snippet after agent-guard block
- **Step 5**: Calls `queryDecisions({ query: "architecture" }, projectRoot)`, renders DecisionPack via `note()`

### src/cli.ts handleSetup() (update)
- Replace stub with: `import { runSetupWizard } from "./setup.js"; await runSetupWizard(projectRoot);`

---

## Key Patterns to Follow

1. **Project root**: `process.env.CONTEXT_LEDGER_PROJECT_ROOT ?? process.cwd()`
2. **Config write**: `JSON.stringify(config, null, 2) + "\n"` (pretty-printed, trailing newline)
3. **Internal imports**: `.js` extensions. External packages: no extension.
4. **File existence**: `try { await access(path) } catch { /* absent */ }`
5. **Cancel handling**: `if (isCancel(result)) { cancel("Setup cancelled."); process.exit(0); }`
6. **Hook marker**: `"context-ledger"` string for idempotency detection
7. **Hook script**: Exact template from cli.ts lines 401-405 with `@mossrussell/context-ledger`
8. **Standing instructions**: Exact snippet from design spec lines 553-576
9. **Binary entry**: shebang + projectRoot + main().catch() pattern from mcp-server-bin.ts

---

## Standing Instructions Snippet (from design spec lines 553-576)

```markdown
## context-ledger Integration

At session start (for non-/auto-feature sessions):
- Check inbox.jsonl for pending items (max 3 per session). Present Tier 2 (must-ask) first.
- Note: /auto-feature handles inbox checks automatically as its first step.

Before modifying architectural patterns, adding/removing dependencies, creating new directories,
or changing established conventions:
- Use query_decisions with the relevant file path (primary) or scope
- If a trusted precedent exists (retrieval_weight >= 0.7, durability = precedent, status = active),
  follow it and cite the decision ID
- If no precedent exists and the choice is ambiguous, flag it as a Bucket 2 question
- If diverging from a precedent, use supersede_decision with rationale and pain_points

After answering Phase 4 Bucket 2 questions:
- Classify each answer as precedent, feature-local, or temporary-workaround
- Use record_writeback for precedent-worthy answers only
- Temporary workarounds require a review_after date

For all MCP write tool calls, generate `client_operation_id` using the pattern:
`{feature-slug}-{YYYYMMDD}-{random4chars}` (e.g., `sqo-export-20260401-a3f2`).
Never reuse operation IDs across calls.
```

---

## Recommended Phase Order

1. **Phase 1**: Implement `src/setup.ts` — all 5 wizard steps + export `runSetupWizard`
2. **Phase 2**: Update `src/cli.ts` handleSetup() to delegate
3. **Phase 3**: Build verification (tsc --noEmit)
4. **Phase 4**: Manual test (npx tsx src/setup.ts)

---

## Risks and Blockers

| Risk | Severity | Mitigation |
|------|----------|------------|
| `installPostCommitHook()` is private in cli.ts | Low | Wizard reimplements hook logic with @clack/prompts UI — different UX pattern, no need to share |
| @clack/prompts `multiselect` returns symbols on cancel | Medium | Every prompt result must be checked with `isCancel()` |
| Directory scan on large monorepos could be slow | Low | Limit to 2 levels deep, use spinner |
| CLAUDE.md injection could corrupt existing content | Medium | Check for `"context-ledger"` marker before injecting, append-only |
| Config write could overwrite user customization | Low | Always loadConfig() first (deep-merges with defaults), then overlay |

---

## Design Spec Compliance

| Spec Requirement | Status |
|-----------------|--------|
| 5 wizard steps (design spec lines 807-825) | Implementing all 5 |
| @clack/prompts only (line 811) | No other UI deps |
| Standing instructions snippet (lines 553-576) | Using exact text |
| Loading order: agent-guard first (line 33) | Appending after agent-guard block |
| Hook system detection order (line 819) | Following cli.ts pattern |
| Scope mapping structure (config.ts ScopeMapping) | Using existing type |
| Feature hint mappings (config retrieval section) | Using existing config field |
| First-run demo with queryDecisions (line 823) | Using existing retrieval API |
| Guided backfill offer (lines 827-842) | Deferred — backfill is separate CLI command, wizard only suggests it |

**Deviation note**: The design spec mentions an optional guided backfill after setup (lines 827-842). The feature request does NOT include implementing the guided backfill flow — only suggesting `context-ledger backfill` as a next step. This is correct: the backfill command already exists as a separate CLI feature.
