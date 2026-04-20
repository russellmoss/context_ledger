# Triage Results — v1.2.2 Council Feedback

Categorization of every council item. Bucket 1 items have been folded into `agentic_implementation_guide.md` (see the Refinement Log at the bottom of that file). Bucket 2 items are surfaced at the Human Input Gate.

Reviewers: **Codex** (local CLI, gpt-5.4) + **Gemini** (gemini-3.1-pro-preview). OpenAI API unavailable per repo policy (quota 429) — Codex is the permanent substitute.

## Bucket 1 — Applied Autonomously

| ID | Summary | Applied In |
|---|---|---|
| C1 | `.gitignore` hook/classifier mismatch → use "any-tree, sole file" semantics in both layers; pass actual path to numstat | Phase 5 Edits 2 & 3 |
| C2 | `inboxItemIntersectsScope` path-derivation copy drifts from `deriveScope` — mirror the monorepo check there too | Phase 1, new section after scope.ts edits |
| C3 | `include_superseded` split-brain between query filter and pack builder — compute once, pass through | Phase 2 Edit + buildDecisionPack signature change |
| C4 | `lockfile_only` path-insensitive — compare (parentDir, basename) tuples | Phase 4 Edit 3 rewrite |
| C5 | `HEAD~1` stderr noise on initial commits — pre-check with `git rev-parse --verify` | Phase 5 Edit 2 |
| C6 | `test:classify` dead-code `classify.test.ts` — chain both files in the npm script | Phase 6 package.json edit |
| S2 | Dangling-pointer comment on cross-scope branch | Phase 2 NEW block comments |
| S3 | Narrative fallback-order prose update | Phase 7 Edit 3 |
| S4 | Windows-path regression in ide_config_only test | Phase 6 test_9 update |
| S5 | Numstat `-` binary-file documentation | Phase 5 Edit 2 comment |
| S6 | Test 12 comment explaining dep-addition category + changed_files semantics | Phase 6 test_12 update |
| S7 | Cross-scope branch-placement comment ("do NOT hoist") | Phase 2 NEW block comments |
| I3 | `deepMerge` boolean-override regression test | Phase 6 test_14 |

### Design defaults applied (council recommendations)

| ID | Question | Choice |
|---|---|---|
| D2 | Multi-hop supersede chain | **One hop** (per feature spec) |
| D3 | Scope id format | `{ id: "packages/foo" }` (namespaced) |
| D4 | Consult `config.monorepo.*` | **No** — hardcode `packages/`, `apps/`, `services/` |
| D5 | Replacement state check in cross-scope branch | **No** — existence + scope match only |

## Bucket 2 — Human Input Needed

Three questions surface at the end of the guide. Autonomous defaults applied but flagged for confirmation.

| ID | Question | Autonomous default |
|---|---|---|
| S1 | `MatchReason` name: `cross_scope_supersede` vs `replacement_scope_hit` | `cross_scope_supersede` |
| D1 | Cross-scope default-surface: gate on `include_superseded` or always surface | Keep gate |
| D6 | `gitignore_trivial` scope: root-only or any-tree | Any-tree (ties C1 to same semantics) |

## Bucket 3 — Noted, Not Applied

| ID | Summary | Reason |
|---|---|---|
| I1 | Generic `fileStats` param (forward-compat for more seed rules) | Out of scope for v1.2.2; revisit at v1.3.0 learning layer |
| I4 | MCP tool description hint about following `replaced_by` | MCP tool annotations unchanged this release per invariants |

## Cross-Checks

- All events conform to existing schema (no new types, no new fields).
- All MCP tool contracts unchanged.
- JSONL append-only invariant preserved.
- Auto-promotion threshold (≥ 0.7, precedent, active) unchanged.
- Token budgeting unchanged.
- Post-commit hook budget preserved — extra git call is conditional (sole `.gitignore` only).
