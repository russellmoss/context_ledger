# Council Feedback — Post-Commit Hook Capture System (src/capture/)

## Sources
- OpenAI (gpt-5.4, reasoning_effort: high)
- Gemini (gemini-3.1-pro-preview)

---

## CRITICAL

### C1: Redaction order is wrong (Both)
Steps 7-8 in hook.ts redact BEFORE building diff_summary. Secrets can leak into the final stored summary.
**Fix:** Build diff_summary first, then redact both commit_message and diff_summary.

### C2: Initial commit / merge commit / rename handling (Both)
- `git diff-tree HEAD` fails on initial commit (no parent) — need `--root` flag
- Merge commits produce empty or misleading output without `-m` flag
- Renames show as add+delete, may falsely trigger module-replacement or new-directory
**Fix:** Use `git diff-tree --root -r` as the default. Add `-c` or skip merge commits. Track renames separately.

### C3: foldLedger in hook risks 100ms budget (Both)
Reading and parsing full ledger.jsonl for Tier 2 contradiction detection could blow past 100ms on large ledgers.
**Fix:** Make Tier 2 contradiction detection best-effort. Gate it: only run if ledger.jsonl exists AND is under a size threshold (e.g., 100KB). If fold fails or times out, emit Tier 1 items only.

### C4: Filename-only metadata insufficient for some classifications (Both)
`git diff-tree --name-only` can't distinguish dependency-addition vs script-change in package.json, can't detect env var additions vs removals, can't detect style-only changes.
**Fix:** For specific high-value files (package.json, .env.example), do targeted content comparison using `git show HEAD:file` vs `git show HEAD~1:file`. Keep it to 2-3 files max to stay under budget.

### C5: Tier 2 contradiction detection underspecified (OpenAI)
The guide doesn't define how foldLedger output maps to a commit change, doesn't mention deriveScope, doesn't define upgrade-from-Tier-1 mechanics.
**Fix:** Specify: for each classified result with structural signals, call deriveScope({file_path}) for its changed files, check if any active decision exists in that scope. If yes, upgrade to Tier 2 with category "contradicts-active-decision".

---

## SHOULD FIX

### S1: ClassifyResult too loosely typed (OpenAI)
Allows nonsense states like `tier: 1, inbox_type: null`. Should be discriminated union or at least validated.
**Fix:** Use a discriminated return: actionable results have tier 1|2 + matching inbox_type + category. Return empty array for ignored, not null-ish results.

### S2: Commit message should be full body, not just subject (OpenAI)
`git log -1 --format=%s` gets only subject. `[no-capture]` in body would be missed. InboxItem.commit_message name suggests full message.
**Fix:** Use `%s` for subject (stored in commit_message — matches the design spec example which shows subject only). But check `%B` (full body) for no_capture_marker.

### S3: Grouping by 2-level prefix is too rigid (Both)
A DB provider switch might touch package.json, prisma/, .env.example, app code — splitting into 4+ inbox items. Deletion cleanup across many directories creates inbox spam.
**Fix:** First classify by change category, then group within category by nearest common ancestor directory. Cap at max 3 inbox items per commit to prevent spam.

### S4: generateInboxId collision risk on multi-item commits (OpenAI)
`hex2` gives only 256 variants per second. Multiple items in same second will collide.
**Fix:** Add a sequence counter within the commit processing loop, or use hex4 for inbox IDs.

### S5: Commit amend creates duplicate inbox items (Gemini)
`git commit --amend` fires post-commit again with new SHA. Old inbox item for old SHA becomes orphaned.
**Fix:** Before appending, check if inbox already has a pending item with the same change_category and overlapping changed_files from within the last 60 seconds. Skip if found.

### S6: Try/catch too coarse (OpenAI)
One big try/catch drops all captures if any step fails. Tier 1 should still work if Tier 2 enrichment fails.
**Fix:** Inner try/catch around Tier 2 contradiction detection. If it fails, fall through to Tier 1 classification.

### S7: normalizePath not consistently applied (OpenAI)
Plan doesn't specify normalizing paths before ignore matching, grouping, dedup, or writing changed_files.
**Fix:** Normalize all file paths immediately after git output parsing, before any classification or filtering.

### S8: Add debug escape hatch (Gemini)
Silent try/catch makes debugging impossible. Add `CONTEXT_LEDGER_DEBUG` env var for verbose stderr output.

### S9: Handle empty commits gracefully (Gemini)
`git commit --allow-empty` returns no files. Should exit cleanly without writing inbox items.

### S10: Large diff memory protection (Gemini)
Large commits (package-lock.json, codegen) could cause memory issues if diff content is read.
**Fix:** Only read content for targeted files (package.json, .env.example). Don't read raw diffs.

---

## DESIGN QUESTIONS

### D1: What exactly should diff_summary contain?
Just category + file counts? Or extracted facts like dependency names, env var names, route paths?
**Recommendation:** Keep it to category + file counts + specific extracted facts for package.json/env files only. Example: `"dependency-addition: +@google/genai ^1.46.0"` or `"config-change: modified tsconfig.json, .eslintrc"`.

### D2: How is contradiction detection scoped deterministically?
Can't know if code "contradicts" a decision without semantic understanding.
**Recommendation:** Define "contradiction" as: file governed by active decision was structurally modified (not content-only). This is deterministic and doesn't require LLM inference.

### D3: Route detection across frameworks
Next.js app router, Express, Remix, etc. all have different patterns.
**Recommendation:** Use broad regex patterns that cover common conventions. Accept false positives — the inbox review step handles them.

### D4: ignore_paths matching model
Prefix match? Glob? Regex?
**Recommendation:** Prefix match on normalized paths. Same as existing behavior in config.ts.

### D5: How should merge commits behave?
**Recommendation:** Skip merge commits entirely (detect via `git rev-parse HEAD^2` succeeding). Merges are integration events, not decision events.

---

## SUGGESTED IMPROVEMENTS

### I1: Consolidate git commands (Both)
Use single `git diff-tree -z --root -r --name-status HEAD` to get status+paths in one call. Parse status letters (A/D/M/R) in JavaScript. Saves 2 execSync calls.

### I2: buildInboxItem helper (OpenAI)
Centralize InboxItem construction with correct defaults. Prevents schema drift.

### I3: Sort and dedupe changed_files (OpenAI)
Stable output helps testing and prevents duplicates from mixed inputs.

### I4: Move no_capture_marker check earlier (Gemini)
Check commit message before running git diff-tree commands. Saves execution time on skipped commits.
