# Council Feedback — v1.2.1 Dogfood Bug Fixes

Adversarial review for `agentic_implementation_guide.md`. Payload: exploration-results.md + guide excerpts + spec invariants summary.

Reviewers: Codex (local CLI, gpt-5.4, adversarial TypeScript focus) + Gemini 3.1 Pro (DX + spec-compliance focus). OpenAI API quota was exhausted (429) — Codex used as substitute per repo feedback policy.

Each finding is tagged [Codex] or [Gemini] and placed in the bucket the reviewer used. My own cross-checks appended at the end.

---

## CRITICAL

- **[Codex] Bug 9 Windows shellout.** `execSync("git log -n 20 --format=%H%x00%s%x00%ct%x00%b%x1e", ...)` uses a shell string. On Windows cmd.exe, `%H`, `%s`, `%b`, `%ct` are environment-variable expansions — the format string is corrupted before git sees it. Fix: use `execFileSync("git", ["log", "-n", "20", "--format=%H%x00%s%x00%ct%x00%b%x1e"], ...)`. Consistent with `getCommitDiff` at hook.ts:74-82 which already uses `execFileSync`.

- **[Codex+Gemini] Bug 7 legacy scope fallback pollutes retrieval.** Hard-coding `scope: { type: "directory", id: "unknown" }` when confirming a legacy inbox item writes that sentinel into a real `DecisionRecord`. Every legacy item's confirmed decision lands in the same `directory/unknown` bucket — queries, mistakes_in_scope, and auto-promotion will group unrelated decisions together. Fix: call `deriveScope({ file_path: item.changed_files[0] }, config, new Map())` in confirm_pending, and only fall back to `directory/<top-segment>` if deriveScope returns null. Fabricated scope fields on confirmed_draft evidence also overstate confidence — may warrant downgrading to a "legacy_confirmed" evidence path, but at minimum the scope must be real.

- **[Codex] Bug 9 abbreviated-SHA collision unsafe.** `entries.find(e => e.sha.startsWith(m[1]))` with a 7-char SHA can match the wrong commit in a moderately-sized repo. 7-char collisions are common past a few thousand commits. Fix: require exact 40-char SHA in the body regex (narrow to `[0-9a-f]{40}`), OR if abbreviated, resolve via `git rev-parse --verify <short>^{commit}` before matching. Second option costs an extra shellout; prefer the first (git's revert generator always writes the full 40-char SHA in body).

---

## SHOULD FIX

- **[Codex+Gemini] Revert detection should key off body, not subject.** `subject.startsWith("Revert ")` is a weak signal — subjects vary with `--no-edit` vs custom, cherry-picked reverts, manual revert subject rewrites. The reliable signal is the body line `This reverts commit <sha>`. Treat the subject as a hint but confirm via body presence. This also removes the revert-of-revert ambiguity Gemini raised (`Revert "Revert ..."` subject still matches the startsWith guard — the body-based check differentiates correctly).

- **[Gemini] Bug 9 use committer date, not author date.** Cherry-picked reverts of old commits would keep an old author date but have a current committer date — author-date comparison silently bypasses the 24h window. Use `%ct` (committer timestamp, Unix epoch) — the guide already does this. Sanity-verify no phase 5 code references `%at`.

- **[Codex] Bug 10 regex recompilation per file.** `globToFilenameRegex(pat)` is called inside the `isEditorBackup` loop, which is inside the `del.filter` callback — regex is compiled O(files × patterns) per classify pass. Fix: precompile patterns once at `classifyCommit` entry (or cache per-module) and pass the compiled array to the matcher.

- **[Codex] Hoisted `perResultDerived` uses arbitrary first file for multi-file classifications.** For mixed-scope commits (classifier splits by cluster per v2.1 spec, but results can still contain multiple paths), stamping the draft with `result.changed_files[0]`'s scope is best-effort. Guide should explicitly document "first-file scope derivation is best-effort for clustered results" and let the user reject draft if the scope is wrong.

- **[Gemini] Add .DS_Store and Thumbs.db to DEFAULT_BACKUP_PATTERNS.** Same UX pattern as editor backups — OS detritus that generates pure-noise file-deletion classifications. Extend default list to `["*.bak", "*.orig", "*.swp", "*.swo", "*~", ".#*", ".DS_Store", "Thumbs.db"]`. Zero marginal code change.

- **[Codex] Malformed user pattern error handling.** `globToFilenameRegex` doesn't guard against a user writing an invalid pattern. If `new RegExp(...)` throws, `isEditorBackup` fails and classification blows up. Wrap the compile step in try/catch; log once per bad pattern and skip it.

- **[Codex] Windows-normalization discipline in Bug 10 matcher.** `filepath.split("/").pop()` assumes forward-slashes. Git diff-tree normalizes to forward-slashes in practice, but defensive code should use the existing `normalizePath` helper in hook.ts before passing to isEditorBackup — OR call classify.ts's internal normalization (whichever is more local). Add one regression test in classify.test.ts that passes a Windows-style path and confirms detection still works.

- **[Gemini] CLI query output should surface scope fields on pending items.** `src/cli.ts handleQuery` currently renders only envelope fields (commit_sha, change_category, commit_message) for pending_inbox_items. With Bug 8's scope population, users can't see the scope unless they `cat` the JSONL. Add scope_type/scope_id to the inbox-render block if the draft payload carries them. This is a small edit and makes the Bug 8 fix visible.

---

## DESIGN QUESTIONS — need user input

- **[Codex+Gemini] Bug 9 "halves the noise" vs "zero inbox items".** The acceptance test says "feat + revert within window → inbox contains zero new items". The current design suppresses only the REVERT's draft (feat already landed when feat's hook fired). Two possible paths:
  - **Accept** the "halves, not eliminates" compromise; CHANGELOG documents it explicitly.
  - **Pursue** a deferred-write design: hook writes to a staging file (`.ledger.inbox.pending`) with a grace period; a timer or the next hook invocation promotes or annihilates. Does NOT violate append-only for inbox.jsonl (staging is ephemeral). More code, better UX, doesn't ship in v1.2.1 if we keep patch-only scope.
  - **User decision required.**

- **[Codex] Legacy-item evidence downgrade.** When a legacy `proposed_decision` inbox is confirmed post-v1.2.1, should it be stamped `confirmed_draft` (weight 0.8) like a fresh draft? Or downgraded (e.g., to `backfill_confirmed` at weight 0.7, or flagged for correction)? Current guide stamps `confirmed_draft` — that overstates confidence for drafts written before scope enrichment existed. **User decision required.**

- **[Codex] Bug 10 — does suppression extend to Tier 2 detectors?** A cleanup commit deleting only `.bak`/`.orig` files could still trip Tier 2's "feature-removal" or "module-replacement" heuristics if those paths are treated as structural removals. Should the editor-backup filter apply globally (anywhere `deleted` is inspected), or narrowly to the file-deletion Tier 1 classifier only? Current guide is narrow. **User decision required.**

- **[Gemini] Custom pattern globs with path segments.** If a user writes `vendor/**/*.bak` in `editor_backup_patterns`, `globToFilenameRegex` + filename-segment-only matching silently ignores the `vendor/**/` part. Either: document that patterns are filename-segment-only, OR upgrade the matcher to honor full-path globs. **User decision required** — but the filename-only semantic is simpler and matches current DEFAULT_BACKUP_PATTERNS usage; document it and call it done.

- **[Gemini] Error messaging when both payload keys absent.** Current: `"Inbox item has no proposed record data"`. Gemini suggests clarifying to `"Missing proposed_record and legacy proposed_decision"` for debugability. **Low-stakes design question** — either is fine; pick one and ship.

---

## SUGGESTED IMPROVEMENTS

- **[Codex] Precompile backup-pattern regexes** at `classifyCommit` entry; pass the RegExp[] to `isEditorBackup`. Removes per-file recompilation cost.

- **[Codex] In Phase 6, use `deriveScope` for legacy fallback** before hard-coding any sentinel. Falls back to `directory/<top-segment-of-changed_files[0]>` only when deriveScope returns null. Preserves retrieval quality without touching DecisionRecord schema.

- **[Codex] Bug 9: use `execFileSync` (not `execSync`) with full arg array.** Removes Windows shell-expansion bug. Parse full SHA from `%H` always. If a body only has abbreviated SHA, resolve via `git rev-parse --verify <short>^{commit}` — git revert-generated commits always write full SHA, so this is belt-and-suspenders.

- **[Codex] Add Windows-path regression test to classify.test.ts.** The classifier is pure, already accepts arbitrary strings — cheap coverage for a real portability edge.

- **[Gemini] Surface scope fields in `context-ledger query` CLI output for pending_inbox_items.** Without this, Bug 8's fix is invisible to users.

- **[Gemini] Anchor boundaries on `.#*` pattern.** Ensure `.env.example` doesn't accidentally match (it won't under the current `.#*` spec — the literal `.#` prefix is required — but add a test case to prove it).

---

## CROSS-CHECKS (performed by orchestrator)

Per the auto-feature skill's Phase 3 checklist:

1. **Every event type in the guide matches `context-ledger-design-v2.md`.** ✅ This patch changes NO event schemas. `DecisionRecord` and `TransitionEvent` are untouched. Only `InboxItem` (a workflow queue, not an event log) and the embedded `ProposedDecisionDraft` shape evolve — same precedent as v1.2.0's `rejection_reason` ratification.

2. **Every MCP tool matches the spec's parameter list and return format.** ✅ No new tools. `propose_decision`, `confirm_pending`, `reject_pending`, `supersede_decision`, `record_writeback`, `query_decisions`, `search_decisions` — all external signatures unchanged. The `confirm_pending` reader fallback changes internal behavior only. MCP tool annotations (`readOnlyHint`, `destructiveHint`, `openWorldHint`) unchanged.

3. **Lifecycle state machine transitions are all legal.** ✅ No new transitions. Bug 7/8/9/10 touch capture and inbox-read paths only. `superseded` stays terminal. No cycles introduced.

4. **Auto-promotion threshold (≥0.7) is enforced correctly.** ✅ Not touched by this patch. `commit_inferred` (0.2) still excluded from auto-promotion and from `mistakes_in_scope`.

5. **Token budgeting on decision packs.** ✅ Unchanged. v1.2.0's trim order (active → superseded → abandoned → pending → mistakes-last) intact.

**Additional orchestrator check — MCP response-shape risk flagged by Gemini:** Gemini's CRITICAL claim that MCP clients expect `proposed_decision` in read output is partially mitigated: `src/mcp/read-tools.ts` query_decisions passes the raw InboxItem through JSON.stringify, so for LEGACY items the `proposed_decision` key still appears in the response naturally. For NEW items, the response will carry `proposed_record`. Any external client that hard-coded `resp.proposed_decision` on freshly-drafted items will break. Risk mitigation: the v1.2.1 patch is shipped with a CHANGELOG callout; no known clients outside the CLI consume this path today. Not promoted to CRITICAL here, but worth documenting in the release notes.

---

## Reviewer Availability Note

Codex responded. Gemini responded. OpenAI returned 429 (quota exhausted) on first attempt — saved to feedback memory that this repo uses codex + gemini going forward, never openai. No additional retry attempted for OpenAI since quota-error is not transient.
