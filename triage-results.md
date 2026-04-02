# Triage Results — Setup Wizard (src/setup.ts)

## Bucket 1 — APPLY AUTONOMOUSLY

| ID | Issue | Fix |
|----|-------|-----|
| C1 | isCancel() not checked after every prompt | Add explicit isCancel() check after every confirm/multiselect call |
| C2 | loadConfig() returns shared DEFAULT_CONFIG on ENOENT — mutation trap | Deep-clone before mutating: `JSON.parse(JSON.stringify(await loadConfig(...)))` or use structuredClone |
| C3 | Config dir must exist before writeFile | Already in guide — verify it's prominent |
| C4 | Windows path normalization for scope_mappings keys | Add `.split("\\").join("/")` + trailing slash normalization |
| C6 | Step 5 uses raw readLedger instead of materialized state | Use queryDecisions() directly, check active_precedents.length |
| C7 | queryDecisions params not specified | Use `{ query: "architecture" }` — already in guide, make prominent |
| S1 | Missing src/ directory crashes Step 2 | Check existence, try alternatives, skip with message if none |
| S2 | Neither CLAUDE.md nor .cursorrules exists | Offer to create CLAUDE.md with confirm() |
| S4 | Idempotency marker too weak | Use `## context-ledger Integration` heading as marker |
| S5 | multiselect with empty options | Check non-empty before calling, skip if empty |
| S6 | Sort suggestions deterministically | Sort alphabetically |
| S7 | feature_hint_mappings merge behavior | Additive merge, never overwrite existing |
| S8 | Agent-guard block detection vague | Search for `## agent-guard` or `# agent-guard` heading |
| S9 | Direct-run detection brittle | Use import.meta.url comparison |
| S10 | No .git directory handling | Detect and warn, skip hook installation |
| S11 | Existing config entries preserved | Additive only — skip existing keys |

## Bucket 2 — NEEDS HUMAN INPUT

| ID | Question | Options |
|----|----------|---------|
| C5 | Hook logic: extract shared module or reimplement? | A) Extract detection into `src/capture/detect-hooks.ts`, reuse in both cli.ts and setup.ts. B) Reimplement in setup.ts with @clack UI (simpler, self-contained, but duplicates detection). |
| S3 | If both CLAUDE.md and .cursorrules exist, inject into which? | A) CLAUDE.md only (primary). B) Both files. C) Ask user. |

## Bucket 3 — NOTE BUT DON'T APPLY

| ID | Item | Reason |
|----|------|--------|
| GPT-monorepo | Monorepo support missing | v1 is explicitly single-repo per design spec |
| GPT-scan-depth | Recursive scan instead of 2-level | Scope expansion — 2-level is sufficient for v1 |
| GPT-EOL-detect | Detect existing EOL style when appending | Over-engineering for v1 |
| GPT-tests | Add tests for edge cases | Good idea but separate task |
| Gemini-auto-select | Auto-select hook system | Already detected — just adds auto-selection UX polish |
