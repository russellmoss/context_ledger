# Triage Results — v1.2.1

Reviewers: Codex (local CLI, gpt-5.4) + Gemini (gemini-3.1-pro-preview). OpenAI API unavailable (quota 429) — Codex is the permanent substitute in this repo.

## Bucket 1 — applied autonomously to `agentic_implementation_guide.md`

See the Refinement Log appended to the guide for the full list. Summary: 10 changes landed, covering all three CRITICAL council items (Windows execSync, scope sentinel pollution, abbreviated-SHA collision), plus code-quality fixes (precompiled regex, malformed-pattern safety, OS-noise patterns, Windows-path normalization, CLI visibility phase, extended test coverage).

## Bucket 2 — awaiting user input

Four open questions. Each has a default the guide will ship with if you say "proceed" without answering specifics.

### Q1 — Bug 9 semantic: "halves" or "eliminates" the inbox noise?

The current guide ships with "halves the noise": when a feat commit runs the hook, the revert doesn't exist yet, so the feat drafts an inbox item. When the revert commit runs the hook, only the revert's draft is suppressed. Net result: 1 draft, not 2 (was previously 2).

**Both reviewers flagged this** as a gap against the literal acceptance-test wording ("feat + revert → zero inbox items"). Two paths:

- **(A) Ship the halving.** CHANGELOG documents explicitly that the suppression fires on the revert only; users manually reject the feat's draft if they see both. Zero additional code. Ships in v1.2.1.
- **(B) Deferred-write design.** Hook writes drafts to a staging file `.context-ledger/inbox.pending` with a grace period (e.g. 5 minutes). A timer or the next hook invocation promotes or annihilates. Does NOT violate append-only for `inbox.jsonl` (staging is ephemeral). Significantly more code; scope-creeps beyond "bug fix". Would probably warrant its own feature cycle and version bump (v1.3.0 not v1.2.1).

**Default if you don't answer: (A).** Ship the halving; land deferred-write as a future feature if dogfood shows the residual noise is worth the complexity.

### Q2 — Legacy-item evidence weighting

When a pre-v1.2.1 `proposed_decision` inbox item is confirmed post-patch, `confirm_pending` stamps `evidence_type: "confirmed_draft"` (retrieval_weight 0.8), same as a fresh draft. Codex flagged this as overstating confidence — the drafted payload predates scope enrichment and may carry less information.

Options:

- **(A) Ship unchanged.** Legacy drafts get 0.8 weight. Precedent: v1.2.0 did the same thing for pre-existing drafts.
- **(B) Introduce a new evidence type** `legacy_confirmed_draft` at weight 0.7 (still auto-promotion eligible but below `confirmed_draft`). Requires: extend `EvidenceType` enum in events.ts, add weight entry, update auto-promotion spec row. Scope creep.
- **(C) Force-flag** legacy items in UI (prefix with `[legacy]` in CLI output, `legacy: true` in MCP response). Cosmetic; no weight change.

**Default if you don't answer: (A).** Ship unchanged. Legacy items are rare (drafter only exists since v1.1.0, ~3 days ago) — the cost/benefit of a new evidence type isn't clear yet.

### Q3 — Bug 10 scope: file-deletion only or all Tier 2 detectors too?

The current guide narrowly suppresses only the Tier 1 `file-deletion` classifier. Codex raised: a cleanup commit containing only `.bak`/`.orig` deletions could still trip Tier 2 detectors (module replacement, feature removal, auth-security-change) that read the same `del` list.

Options:

- **(A) Narrow.** Suppress only Tier 1 `file-deletion`. Current guide ships this. Low risk of over-suppression. Documented in Phase 3 STOP AND REPORT.
- **(B) Broad.** Apply editor-backup filter globally anywhere the classifier reads `del` — propagate `backupPatterns` through `classifyCommit` and filter at every consumer.

**Default if you don't answer: (A).** Narrow. Tier 2 detectors are rare to trip and have their own semantic gates; a dogfood report showing Tier 2 noise from backup cleanup would justify broadening in a follow-up.

### Q4 — CLI scope rendering (Phase 6.5): ship in v1.2.1?

Added a new Phase 6.5 that renders `scope: <type>/<id>` on pending inbox items in `context-ledger query` output. Reviewers flagged that Bug 8's fix is invisible without this. It's ~4 lines of code in `src/cli.ts handleQuery`, guarded by a simple null-check.

Options:

- **(A) Include in v1.2.1.** Ship with Phase 6.5. Bug 8 visible without cat-ing JSONL. (Current default.)
- **(B) Defer.** Remove Phase 6.5; ship without CLI visibility; rely on MCP query path + users' direct JSONL inspection.

**Default if you don't answer: (A).** Include. The change is tiny, the visibility gain is meaningful, and it's strictly additive to the CLI output format (no breaking change to existing output).

## Bucket 3 — noted, not applied

- Error message wording (cosmetic).
- Deferred-write staging (scope expansion; promoted to Q1 as (B) option).
- Evidence-type downgrade (scope expansion; promoted to Q2 as (B) option).

## Human Input Gate — ready message

If you're comfortable with defaults (A) on all four questions, say "proceed with defaults". Otherwise, answer per-question (e.g. "Q1: A, Q2: C, Q3: A, Q4: A") and I'll apply any deltas.

Once the guide is final, run `/compact` to clear context, then: **Execute `agentic_implementation_guide.md` phase by phase.**
