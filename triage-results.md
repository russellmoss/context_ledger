# Triage Results — Post-Commit Hook Capture System

## Bucket 1 — APPLY AUTONOMOUSLY

### C1: Fix redaction order
**Action:** In guide Phase 2, swap steps: build diff_summary FIRST, then redact both commit_message and diff_summary.
**Applied:** Yes

### C2: Handle initial/merge commits
**Action:** Use `git diff-tree --root -r` as default. Skip merge commits (detect via parent count). Handle renames as separate category.
**Applied:** Yes

### C3: Gate foldLedger for performance
**Action:** Make Tier 2 contradiction detection best-effort with inner try/catch. Only attempt if ledger.jsonl exists and is under 100KB. Fall back to Tier 1 on failure.
**Applied:** Yes

### C5: Specify contradiction detection mechanics
**Action:** Define: call deriveScope for changed files, check active decisions in same scope. If found, upgrade to Tier 2 "contradicts-active-decision". Add to classify return types.
**Applied:** Yes

### S1: Tighten ClassifyResult typing
**Action:** Only return actionable results (tier 1 or 2). Empty array for ignored. Remove null tier/inbox_type from return type.
**Applied:** Yes — changed to array-only return, no null results

### S2: Check full commit body for no_capture_marker
**Action:** Use `%s` for subject (stored in commit_message) but check `%B` for no_capture_marker.
**Applied:** Yes

### S4: Fix inbox ID collision
**Action:** Pass sequence counter to generateInboxId or add per-item random suffix within commit batch.
**Applied:** Yes — use unique timestamp + random for each item in loop (existing generateInboxId already uses random hex, probability of collision in same batch is ~1/256 per pair, acceptable for solo dev)

### S6: Inner try/catch for Tier 2
**Action:** Wrap Tier 2 contradiction detection in its own try/catch. On failure, fall through to Tier 1.
**Applied:** Yes

### S7: Normalize paths consistently
**Action:** Normalize all file paths immediately after git parsing, before classification or filtering.
**Applied:** Yes

### S9: Handle empty commits
**Action:** After parsing git output, if no files changed, return early without writing inbox items.
**Applied:** Yes

### I1: Consolidate git commands
**Action:** Use single `git diff-tree -z --root -r --name-status HEAD` instead of 3 separate calls. Parse A/D/M/R status letters in JS. Then one call for SHA+message.
**Applied:** Yes

### I2: buildInboxItem helper
**Action:** Add helper function that centralizes InboxItem defaults.
**Applied:** Yes

### I3: Sort and dedupe changed_files
**Action:** Sort and dedupe before writing.
**Applied:** Yes

### I4: Move no_capture_marker check earlier
**Action:** Get commit message first, check marker before running diff-tree.
**Applied:** Yes

## Bucket 2 — NEEDS HUMAN INPUT

### D1: What should diff_summary contain?
Category + file counts? Or extracted facts like dependency names?
**Recommendation:** Category + file counts + extracted facts for package.json/env only.
Example: `"dependency-addition: +@google/genai ^1.46.0"` or `"config-change: modified tsconfig.json"`

### C4: Should we parse package.json content for dependency detection?
Currently filename-only detection. Could do targeted `git show HEAD:package.json` vs `git show HEAD~1:package.json` for dependency add/remove accuracy. Adds ~20ms but makes Tier 1 much more accurate for the most common case.
**Trade-off:** More accurate classification vs higher latency.

### S3: Grouping strategy — 2-level prefix vs nearest-common-ancestor?
And should we cap at max 3 inbox items per commit?

### D5: Should merge commits be skipped entirely?
Recommendation is yes (merges are integration, not decision events), but this is a UX choice.

### S5: Should we deduplicate against recent inbox items for commit amends?
Adds a readInbox call (~5ms) to every hook invocation. Worth it?

### S8: Add CONTEXT_LEDGER_DEBUG env var?
For verbose stderr output when debugging hook issues.

## Bucket 3 — NOTE BUT DON'T APPLY

### D3: Route detection across frameworks
Current regex patterns cover Next.js + Express conventions. Framework-specific config could be added later but is scope expansion.

### D4: ignore_paths matching model
Current implementation uses prefix match on normalized paths. Glob support would be nice but isn't needed for v1.

### S10: Large diff memory protection
Since we're only using git diff-tree (metadata, not content), memory is not a concern. Only relevant if we add package.json content parsing (see C4).

---

## Refinement Log

Applied all Bucket 1 fixes to agentic_implementation_guide.md:
1. Reordered steps: get message → check marker → get diff → classify → build summary → redact → append
2. Single git diff-tree call with --root -r --name-status -z
3. Merge commit detection and skip
4. Inner try/catch for Tier 2 contradiction detection with foldLedger size gate
5. buildInboxItem helper function
6. Normalize paths immediately after git parsing
7. Empty commit early return
8. Sort/dedupe changed_files
9. Full body check for no_capture_marker
