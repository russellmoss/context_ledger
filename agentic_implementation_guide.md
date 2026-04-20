# v1.2.2 Agentic Implementation Guide

Three cold-path fixes for context-ledger v1.2.2. Zero event-schema changes, zero MCP tool changes, zero runtime deps added. Execute phase by phase. Each phase has a **STOP AND REPORT** gate — run the listed validation commands, report pass/fail, and wait for go/no-go before starting the next phase.

**Working directory:** `C:\Users\russe\Documents\Context_Ledger`

**Reference documents:**
- `exploration-results.md` (synthesized phase summary + risks)
- `code-inspector-findings.md` (types, line numbers, construction sites)
- `pattern-finder-findings.md` (patterns to mirror)
- `context-ledger-design-v2.md` (design spec — source of truth)

**Global invariants — enforce in every phase:**
- JSONL append-only with trailing newline — none of these fixes write events, but don't regress the helpers.
- All imports use `.js` extensions (Node16 resolution).
- Zero new runtime dependencies.
- Import MERGES, not additions — if a module is already imported, extend the existing import clause; do not add a second `import ... from "same/module"` line.
- MCP tool annotations unchanged.
- Post-commit hook must stay under 100ms, zero LLM, zero network — Issue 3 adds at most one conditional `git diff --numstat` call, fired only when `.gitignore` is the sole changed file.

---

## Phase 0 — Preconditions

**Goal:** confirm the baseline before editing.

### Steps

1. Verify git clean:
   ```bash
   git status --porcelain
   ```
   Expect empty output.

2. Confirm current version is 1.2.1:
   ```bash
   grep '"version"' package.json
   ```
   Expect `"version": "1.2.1",`.

3. Baseline build:
   ```bash
   npm run build
   ```
   Expect zero TypeScript errors.

4. Baseline tests:
   ```bash
   npm test
   ```
   Record which test scripts exist and their baseline pass counts. Note whether `test:classify` in `package.json` points to a file that actually exists (risk-item #4 in exploration-results.md).

5. Read TODO.md items 5, 6, and 7 to reconcile any wording differences from the feature spec. The TODO is the authoritative capture per the inspector.

6. Confirm key anchor lines haven't drifted:
   - `src/retrieval/packs.ts:10` — `MatchReason` type definition.
   - `src/retrieval/packs.ts:109` — `buildDecisionPack` include_superseded gate.
   - `src/retrieval/scope.ts:9-15` — `ScopeSource` type.
   - `src/retrieval/scope.ts:76-89` — directory fallback block.
   - `src/retrieval/query.ts:32-92` — `inboxItemIntersectsScope` helper (MIRROR of deriveScope; must be updated in lockstep per its own comment on line 37–38).
   - `src/retrieval/query.ts:122-191` — filter loop with match-reason assignment.
   - `src/capture/classify.ts:193-222` — `classifyCommit` entrance and pre-classification filters.
   - `src/config.ts:23-25, 38, 72` — `ClassifierCaptureConfig`, the optional field on `LedgerConfig`, and the default.
   - `src/capture/hook.ts:238-274` — `parsePackageJsonDiff` helper (pattern to mirror).
   - `src/capture/hook.ts:365-373` — pkgDiff plumbing and `classifyCommit` call site.

7. Verify test-runner wiring (council C6). Confirm:
   ```bash
   grep '"test:classify"' package.json
   ls src/capture/smoke-test.ts src/capture/classify.test.ts
   ```
   Current state (per Phase 0 verification on 2026-04-19): `test:classify` runs `node dist/capture/smoke-test.js`. The `classify.test.ts` file exists but is NOT wired into the npm script chain. Phase 6 will fix this by chaining both files into `test:classify`.

### Validation gate

```bash
npm run build && git status --porcelain
```
Build must pass; repo must be clean.

**STOP AND REPORT:** baseline confirmed (version / build / tests / anchor lines). Do NOT proceed if the baseline fails.

---

## Phase 1 — Issue 2: Monorepo-Root Scope Fallback

Smallest, zero-ripple change. Insert a monorepo-root check between `scope_aliases` and the existing directory fallback in `deriveScope`. Returns `{ type: "directory", id: "packages/foo", source: "monorepo_root" }`.

**Design decision (recorded here, surfaced in CHANGELOG & design spec):** return `type: "directory"` (not `"package"`). The classifier doesn't verify whether the subdirectory is a real npm/Cargo/etc. package; calling it a "directory" is honest and matches the shape of the existing `directory_fallback`.

### File: `src/retrieval/scope.ts`

**Edit 1 — extend the `ScopeSource` union (lines 9-15).** Insert `"monorepo_root"` between `"directory_fallback"` and `"feature_hint"`:

```ts
export type ScopeSource =
  | "explicit"
  | "config_mapping"
  | "scope_alias"
  | "directory_fallback"
  | "monorepo_root"
  | "feature_hint"
  | "recency_fallback";
```

**Edit 2 — add a monorepo-root helper** near the top of the file (below `normalizePath`, above `deriveScope`). Keep it module-local (not exported):

```ts
// ── Monorepo Root Detection (v1.2.2) ─────────────────────────────────────────
// When a path lives under a common monorepo root (packages/, apps/, services/),
// return the top-level package directory id like "packages/foo". Preserves
// current directory-fallback behavior for unrecognized paths.
const MONOREPO_ROOTS: readonly string[] = ["packages", "apps", "services"];

function deriveMonorepoRootScope(segments: string[]): { id: string } | null {
  if (segments.length < 2) return null;
  const first = segments[0];
  if (!MONOREPO_ROOTS.includes(first)) return null;
  const pkg = segments[1];
  if (!pkg || pkg.startsWith(".")) return null;
  return { id: `${first}/${pkg}` };
}
```

**Edit 3 — insert the monorepo check in `deriveScope`** inside the existing `if (params.file_path) { ... }` block. The check goes between step 2b (scope_alias loop, ending at line 73) and step 2c (directory fallback, starting at line 76). Replace the existing `// 2c: Directory fallback` block with this extended version that tries monorepo root first:

**OLD (lines 75-89):**
```ts
    // 2c: Directory fallback
    const segments = normalized.split("/").filter((s) => s !== "" && s !== "." && s !== "..");
    const srcIndex = segments.indexOf("src");
    let scopeId: string | null = null;

    if (srcIndex >= 0 && srcIndex + 1 < segments.length) {
      scopeId = segments[srcIndex + 1];
    } else if (segments.length >= 2) {
      // No src/ segment — use first meaningful directory segment
      scopeId = segments[0];
    }

    if (scopeId) {
      return { type: "directory", id: scopeId, source: "directory_fallback" };
    }
```

**NEW:**
```ts
    // 2c: Monorepo-root fallback (v1.2.2) — walks "packages/<pkg>/..." paths
    // to their top-level package directory before falling back to basename.
    const segments = normalized.split("/").filter((s) => s !== "" && s !== "." && s !== "..");
    const monorepo = deriveMonorepoRootScope(segments);
    if (monorepo) {
      return { type: "directory", id: monorepo.id, source: "monorepo_root" };
    }

    // 2d: Directory fallback (original behavior for non-monorepo paths)
    const srcIndex = segments.indexOf("src");
    let scopeId: string | null = null;

    if (srcIndex >= 0 && srcIndex + 1 < segments.length) {
      scopeId = segments[srcIndex + 1];
    } else if (segments.length >= 2) {
      // No src/ segment — use first meaningful directory segment
      scopeId = segments[0];
    }

    if (scopeId) {
      return { type: "directory", id: scopeId, source: "directory_fallback" };
    }
```

### File: `src/retrieval/query.ts` — Update `inboxItemIntersectsScope` (council C2)

`inboxItemIntersectsScope` (lines 32–92) is a COPY of the `deriveScope` logic with its own file-name-derivation chain. Its own comment on line 37–38 reads: *"Mirrors deriveScope() in src/retrieval/scope.ts:31–102. Any future change to deriveScope MUST update this helper in lockstep to prevent drift."*

Phase 1 is that change. Without this update, `mistakes_in_scope` and dismissed-inbox entries for monorepo-root-derived queries will silently drift.

**Edit — insert monorepo-root check into the per-file loop** (between scope_alias section lines 75–82 and directory fallback lines 84–89):

**OLD:**
```ts
    // 2. scope_aliases — scan active decisions (mirror scope.ts:65–73)
    for (const folded of state.decisions.values()) {
      if (folded.state !== "active") continue;
      if (folded.record.scope.type !== scope.type || folded.record.scope.id !== scope.id) continue;
      for (const alias of folded.record.scope_aliases) {
        if (n.startsWith(normalizePath(alias))) return true;
      }
    }

    // 3. Directory fallback (mirror scope.ts:76–89)
    const segments = n.split("/");
    const srcIdx = segments.indexOf("src");
    const segment =
      srcIdx >= 0 && srcIdx + 1 < segments.length ? segments[srcIdx + 1] : segments[0];
    if (segment === scope.id) return true;
```

**NEW:**
```ts
    // 2. scope_aliases — scan active decisions (mirror scope.ts:65–73)
    for (const folded of state.decisions.values()) {
      if (folded.state !== "active") continue;
      if (folded.record.scope.type !== scope.type || folded.record.scope.id !== scope.id) continue;
      for (const alias of folded.record.scope_aliases) {
        if (n.startsWith(normalizePath(alias))) return true;
      }
    }

    // 2.5 Monorepo-root fallback (v1.2.2) — mirror scope.ts monorepo_root branch.
    // If the file lives under packages/<pkg>/..., derive "packages/<pkg>" and
    // compare against the queried scope.
    const monorepoRoots = ["packages", "apps", "services"];
    const msegments = n.split("/").filter((s) => s !== "" && s !== "." && s !== "..");
    if (msegments.length >= 2 && monorepoRoots.includes(msegments[0])) {
      const pkg = msegments[1];
      if (pkg && !pkg.startsWith(".") && `${msegments[0]}/${pkg}` === scope.id) {
        return true;
      }
    }

    // 3. Directory fallback (mirror scope.ts:76–89)
    const segments = n.split("/");
    const srcIdx = segments.indexOf("src");
    const segment =
      srcIdx >= 0 && srcIdx + 1 < segments.length ? segments[srcIdx + 1] : segments[0];
    if (segment === scope.id) return true;
```

(Why not extract a helper? Deferred to v1.3.0 — this patch is narrow. The two-place duplication is acknowledged in the existing comment and now tracked in both places.)

### File: `src/retrieval/smoke-test.ts`

Add a new test function mirroring the existing `test2_directoryFallback` pattern. The test must:

- Build a config with empty `scope_mappings`.
- Derive scope for `packages/foo/src/bar.ts`, assert `source === "monorepo_root"` and `id === "packages/foo"`.
- Derive scope for `apps/web/pages/index.tsx`, assert `id === "apps/web"`, source `"monorepo_root"`.
- Regression: derive scope for `src/ledger/fold.ts` (no monorepo root) — assert `source === "directory_fallback"` and `id === "ledger"` (behavior unchanged).
- Register the new test in the `main()` runner (or whatever entry point invokes sequential test functions in this file — mirror the existing test N+1 pattern exactly).

### Validation gate

```bash
npm run build
npm run test:retrieval
grep -n '"monorepo_root"' src/retrieval/scope.ts src/retrieval/query.ts
```

- Build: zero errors.
- `test:retrieval`: all prior tests still pass; new monorepo test passes.
- grep: hits in BOTH `scope.ts` (type + branch) and `query.ts` (inboxItemIntersectsScope mirror) — the lockstep-update invariant.

**STOP AND REPORT:** monorepo fallback working in deriveScope AND inboxItemIntersectsScope; directory_fallback preserved for non-monorepo paths.

---

## Phase 2 — Issue 1: Cross-Scope Supersede Traversal

Extend `MatchReason` union and teach `queryDecisions` to surface superseded records whose `replaced_by` target has a scope matching the query.

**Human-gate decision (Q2 → option B).** Cross-scope supersede entries now surface at default params, regardless of `include_superseded`. Rationale: a superseded record whose replacement is in the query scope is not "stale history" — it is the genealogy of the currently-active record the user is asking about. Surfacing the ancestor is provenance, not pack pollution. Escape hatch: new optional per-query param `include_cross_scope_supersede?: boolean` (default `true`). Passing `false` skips the cross-scope branch entirely for that query. No new config-level field — the per-query param is the only control surface.

Invariant preserved: MCP tool annotations (`readOnlyHint: true, destructiveHint: false, openWorldHint: false`) unchanged — only the input schema gains one optional boolean.

### File: `src/retrieval/packs.ts`

**Edit 1 — extend `MatchReason` (line 10):**

**OLD:**
```ts
export type MatchReason = "scope_hit" | "file_path_hit" | "tag_match" | "broad_fallback";
```

**NEW:**
```ts
export type MatchReason =
  | "scope_hit"
  | "file_path_hit"
  | "tag_match"
  | "broad_fallback"
  | "cross_scope_supersede";
```

No other changes to `packs.ts`. `recentlySuperseded` (lines 109-118) already accepts any `MatchReason`; the new value flows through unchanged.

### File: `src/retrieval/query.ts`

**Edit — extend the filter loop (lines 122-192).** Insert a new `else if` branch AFTER the existing `tag_match` block (line 186) and BEFORE the `if (!matchReason) continue;` guard (line 189). The new branch must:

- Fire only when `derivedScope !== null` (cross-scope traversal needs a target scope to match).
- Fire only when `folded.state === "superseded"`.
- Fire only when the per-query opt-out is NOT set: `params.include_cross_scope_supersede ?? true`. Default behavior is surface-on (Q2 → B).
- Follow exactly one hop: look up `state.decisions.get(folded.replaced_by)`; check that replacement's scope matches `derivedScope`. Do not chain through multiple supersedes.

**Note — divergence from other `recently_superseded` entries.** Same-scope superseded records (matched via `scope_hit`, `file_path_hit`, or `tag_match` on the record's OWN scope) continue to require `include_superseded: true` in `buildDecisionPack` (unchanged behavior). Cross-scope entries bypass that gate. This is the intended asymmetry: the query's scope ALWAYS wants to know about history that was superseded INTO it, never wants stale history from OTHER scopes unless opted in.

**Exact insertion** (between current lines 186 and 189). Replace this segment:

**OLD:**
```ts
      // Tag match
      if (!matchReason && params.tags && params.tags.length > 0) {
        const hasTagOverlap = folded.record.tags.some((t) =>
          params.tags!.some((pt) => t.toLowerCase() === pt.toLowerCase()),
        );
        if (hasTagOverlap) matchReason = "tag_match";
      }
    }

    if (!matchReason) continue;
```

**NEW:**
```ts
      // Tag match
      if (!matchReason && params.tags && params.tags.length > 0) {
        const hasTagOverlap = folded.record.tags.some((t) =>
          params.tags!.some((pt) => t.toLowerCase() === pt.toLowerCase()),
        );
        if (hasTagOverlap) matchReason = "tag_match";
      }

      // Cross-scope supersede traversal (v1.2.2) — one hop only.
      // derivedScope is guaranteed non-null here (we are inside the outer
      // `else { derivedScope !== null }` branch — do NOT hoist this check
      // out). A superseded record surfaces in scope S's pack when its
      // replaced_by points to a decision whose scope matches S, even if the
      // superseded record's own scope was narrower or different.
      //
      // Surfaces at default params: cross-scope supersedes are the genealogy
      // of the record IN scope, not stale history. Opt-out per query via
      // include_cross_scope_supersede: false. Unlike same-scope superseded
      // records, this branch does NOT honor include_superseded — those are
      // different semantics (see Phase 2 note in the guide).
      //
      // Replacement may be missing if the ledger was trimmed/corrupted —
      // `state.decisions.get` returns undefined; the guard below treats it
      // as "no match" and the record is skipped.
      if (
        !matchReason &&
        folded.state === "superseded" &&
        folded.replaced_by &&
        includeCrossScopeSupersede
      ) {
        const replacement = state.decisions.get(folded.replaced_by);
        if (
          replacement &&
          replacement.record.scope.type === derivedScope.type &&
          replacement.record.scope.id === derivedScope.id
        ) {
          matchReason = "cross_scope_supersede";
        }
      }
    }

    if (!matchReason) continue;
```

**Double-counting note:** because every assignment is guarded with `if (!matchReason)`, a superseded record that also happens to match on its own scope/file/tag keeps the earlier reason and never reaches the cross-scope branch. Correct — no dedup logic needed.

### Council C3 + Q2 escape hatch — booleans threaded end-to-end

Two booleans flow through `queryDecisions` → `buildDecisionPack` to avoid split-brain behavior between filter and packer:

- **`includeSuperseded`** — resolves `params.include_superseded ?? config.retrieval.include_superseded`. Gates SAME-SCOPE superseded records (existing behavior, plus the config fallback that was missing). **(Council C3 fix.)**
- **`includeCrossScopeSupersede`** — resolves `params.include_cross_scope_supersede ?? true`. Gates CROSS-SCOPE superseded records. Default true = surface-on, opt-out per query. **(Q2 human-gate decision.)**

**Edit 1 — extend `QueryDecisionsParams` in `src/retrieval/query.ts`:**

Add:
```ts
include_cross_scope_supersede?: boolean;
```
to the existing `QueryDecisionsParams` interface (around line 22, alongside `include_superseded`).

**Edit 2 — compute both effective booleans ONCE at the top of `queryDecisions`** (right after `deriveScope` call, around line 115):

```ts
// v1.2.2 council C3: resolve include_superseded once with config fallback,
// reuse in filter loop + pack builder to avoid split-brain.
const includeSuperseded = params.include_superseded ?? config.retrieval.include_superseded;
// v1.2.2 Q2 human-gate: cross-scope supersedes default surface-on. Opt out
// per query via include_cross_scope_supersede: false. No config-level field.
const includeCrossScopeSupersede = params.include_cross_scope_supersede ?? true;
```

Use `includeCrossScopeSupersede` in the cross-scope branch above.

**Edit 3 — change `buildDecisionPack` signature** to accept BOTH effective booleans. In `src/retrieval/packs.ts:70–77`:

**OLD:**
```ts
export function buildDecisionPack(
  decisions: Array<FoldedDecision & { match_reason: MatchReason }>,
  scope: DerivedScope | null,
  inboxItems: InboxItem[],
  rejectedInboxItems: InboxItem[],
  params: { include_superseded?: boolean; include_unreviewed?: boolean; include_feature_local?: boolean; limit?: number; offset?: number },
  config: LedgerConfig,
): DecisionPack {
```

**NEW:**
```ts
export function buildDecisionPack(
  decisions: Array<FoldedDecision & { match_reason: MatchReason }>,
  scope: DerivedScope | null,
  inboxItems: InboxItem[],
  rejectedInboxItems: InboxItem[],
  params: { include_superseded?: boolean; include_unreviewed?: boolean; include_feature_local?: boolean; limit?: number; offset?: number },
  config: LedgerConfig,
  effectiveIncludeSuperseded?: boolean,       // v1.2.2 C3 — defaults to params.include_superseded for back-compat.
  effectiveIncludeCrossScope?: boolean,       // v1.2.2 Q2 — defaults true (surface cross-scope supersedes by default).
): DecisionPack {
  const includeSuperseded = effectiveIncludeSuperseded ?? params.include_superseded ?? false;
  const includeCrossScope = effectiveIncludeCrossScope ?? true;
```

(Back-compat: existing callers pass 6 args; new trailing optionals preserve their behavior for callers that don't pass them. Only `queryDecisions` passes the new 7th and 8th arguments.)

**Edit 4 — in `buildDecisionPack` line 109, update the superseded branch** to admit cross-scope entries unconditionally and other superseded entries only when `includeSuperseded` is true:

**OLD:**
```ts
    } else if (folded.state === "superseded" && params.include_superseded) {
      const lastSupersede = findLastTransition(folded, "supersede");
      if (lastSupersede && now - new Date(lastSupersede.created).getTime() <= ninetyDaysMs) {
        recentlySuperseded.push({
          record: folded.record,
          match_reason: folded.match_reason,
          replaced_by: folded.replaced_by ?? "",
        });
      }
    }
```

**NEW:**
```ts
    } else if (folded.state === "superseded") {
      // v1.2.2 Q2: cross-scope supersedes surface even when include_superseded
      // is false — they are genealogy of the in-scope record, not stale history.
      // Same-scope superseded records continue to require include_superseded.
      const isCrossScope = folded.match_reason === "cross_scope_supersede";
      const gate = isCrossScope ? includeCrossScope : includeSuperseded;
      if (!gate) continue;
      const lastSupersede = findLastTransition(folded, "supersede");
      if (lastSupersede && now - new Date(lastSupersede.created).getTime() <= ninetyDaysMs) {
        recentlySuperseded.push({
          record: folded.record,
          match_reason: folded.match_reason,
          replaced_by: folded.replaced_by ?? "",
        });
      }
    }
```

**Edit 5 — at the `queryDecisions` call site, pass both effective booleans:**
```ts
return buildDecisionPack(paged, derivedScope, pendingInbox, rejectedInboxItems, params, config, includeSuperseded, includeCrossScopeSupersede);
```

### Edit 6 — MCP Zod schema for `query_decisions` (`src/mcp/read-tools.ts`)

Add the new optional param to the Zod input schema. Annotations (`readOnlyHint`, `destructiveHint`, `openWorldHint`) unchanged — only the input schema grows one optional field.

**OLD (line 19–21):**
```ts
      include_superseded: z.boolean().optional().describe("Include recently superseded decisions (default false)"),
      include_unreviewed: z.boolean().optional().describe("Include unreviewed decisions (default false)"),
      include_feature_local: z.boolean().optional().describe("Include feature-local durability records (overrides the default file-path-match requirement). Default false."),
```

**NEW:**
```ts
      include_superseded: z.boolean().optional().describe("Include same-scope recently superseded decisions (default false). Cross-scope supersedes — where the replacement record's scope matches the query — surface regardless of this flag; use include_cross_scope_supersede to opt out of those."),
      include_unreviewed: z.boolean().optional().describe("Include unreviewed decisions (default false)"),
      include_feature_local: z.boolean().optional().describe("Include feature-local durability records (overrides the default file-path-match requirement). Default false."),
      include_cross_scope_supersede: z.boolean().optional().describe("Include cross-scope superseded records whose replacement is in the query scope. Default true — these are genealogy of the in-scope record, not stale history. Set false to suppress."),
```

**Also update the tool description** (line 11) to mention the new default behavior:

**OLD:**
```
"Retrieve relevant decision records for a file path, query, or scope. Returns a decision pack with prior mistakes in scope (antipatterns surfaced first), active precedents, abandoned approaches, recently superseded decisions, and pending inbox items."
```

**NEW:**
```
"Retrieve relevant decision records for a file path, query, or scope. Returns a decision pack with prior mistakes in scope (antipatterns surfaced first), active precedents, abandoned approaches, recently superseded decisions (same-scope on opt-in, cross-scope by default when the replacement is in scope), and pending inbox items."
```

Annotations block at line 25 stays byte-for-byte identical. Invariant preserved.

### File: `src/retrieval/smoke-test.ts`

Add FOUR new test functions mirroring `testA_mistakesSuperseded` (lines 356-402 in the existing file):

**Test 1 — cross-scope surfaces at default params (Q2 → B):**
- Seed a concern-scoped decision `D_A` (e.g. `{ type: "concern", id: "test-planning" }`).
- Seed a package-scoped decision `D_B` (e.g. `{ type: "directory", id: "packages/foo" }`).
- Append a supersede transition: `D_A` superseded by `D_B`.
- Call `queryDecisions` with `scope_type: "directory"`, `scope_id: "packages/foo"` and NO other flags (default params — `include_superseded` unset, `include_cross_scope_supersede` unset).
- Assert `pack.recently_superseded.length === 1`, `pack.recently_superseded[0].record.id === D_A.id`, and `pack.recently_superseded[0].match_reason === "cross_scope_supersede"`.
- This is the dogfood-bug happy path.

**Test 2 — cross-scope opt-out (escape hatch):**
- Repeat the seeding. Query with `include_cross_scope_supersede: false`. Assert `pack.recently_superseded.length === 0`. Same-scope `include_superseded` is irrelevant here since `D_A` is not in the query scope.

**Test 3 — same-scope superseded still requires include_superseded (regression guard):**
- Seed a package-scoped decision `D_C` (scope `{ type: "directory", id: "packages/foo" }`).
- Seed another package-scoped decision `D_D` (same scope as `D_C`).
- Supersede transition: `D_C` superseded by `D_D`.
- Query with `scope_type: "directory"`, `scope_id: "packages/foo"` and default params.
- Assert `pack.recently_superseded.length === 0` — `D_C` is same-scope superseded, so `include_superseded` default of `false` hides it. Proves the Q2 change doesn't leak into same-scope semantics.
- Re-query with `include_superseded: true`. Assert `pack.recently_superseded.length === 1` and `match_reason === "scope_hit"` (NOT `cross_scope_supersede` — it matched on its own scope first per the precedence order).

**Test 4 — config-default bridge (council C3 regression):**
- Seed same-scope pair as Test 3. Write config with `retrieval.include_superseded = true`. Query WITHOUT passing `include_superseded`.
- Assert `pack.recently_superseded.length === 1`. This catches the split-brain fix: `buildDecisionPack` must honor the resolved `includeSuperseded` (not just raw `params.include_superseded`).

Register all four new tests in the runner.

### Validation gate

```bash
npm run build
npm run test:retrieval
grep -n '"cross_scope_supersede"' src/retrieval/packs.ts src/retrieval/query.ts
grep -n 'include_cross_scope_supersede' src/retrieval/query.ts src/mcp/read-tools.ts
grep -n 'readOnlyHint: true, destructiveHint: false, openWorldHint: false' src/mcp/read-tools.ts
```

- Build: zero errors.
- `test:retrieval`: prior tests all green; four new cross-scope tests green.
- grep 1: one hit in `packs.ts` (type), one hit in `query.ts` (assignment).
- grep 2: hits in `query.ts` (param on interface + resolution line) and `read-tools.ts` (Zod schema field).
- grep 3: annotations block present and unchanged — MCP invariant held.

**STOP AND REPORT:** cross-scope traversal surfaces at default params; escape hatch works; same-scope gate preserved.

---

## Phase 3 — Issue 3a: Config Surface for Seed Rules

Surface-level only. Add `SeedRulesConfig`, extend `ClassifierCaptureConfig`, seed defaults. No behavior change yet — predicates land in Phase 4.

### File: `src/config.ts`

**Edit 1 — add `SeedRulesConfig` and extend `ClassifierCaptureConfig` (replace lines 23-25):**

**OLD:**
```ts
export interface ClassifierCaptureConfig {
  editor_backup_patterns: string[];
}
```

**NEW:**
```ts
export interface SeedRulesConfig {
  gitignore_trivial?: boolean;  // default: true — suppress single-line .gitignore-only commits
  ide_config_only?: boolean;    // default: true — suppress commits touching only per-developer IDE config dirs
  lockfile_only?: boolean;      // default: true — suppress commits changing only lockfiles without their manifests
}

export interface ClassifierCaptureConfig {
  editor_backup_patterns: string[];
  seed_rules?: SeedRulesConfig;
}
```

**Edit 2 — extend the default at line 72:**

**OLD:**
```ts
    classifier: { editor_backup_patterns: ["*.bak", "*.orig", "*.swp", "*.swo", "*~", ".#*", ".DS_Store", "Thumbs.db"] },
```

**NEW:**
```ts
    classifier: {
      editor_backup_patterns: ["*.bak", "*.orig", "*.swp", "*.swo", "*~", ".#*", ".DS_Store", "Thumbs.db"],
      seed_rules: {
        gitignore_trivial: true,
        ide_config_only: true,
        lockfile_only: true,
      },
    },
```

No other changes. `deepMerge` already handles nested plain objects — a user config with `{ seed_rules: { lockfile_only: false } }` will merge correctly and leave the other two booleans at their defaults.

### Validation gate

```bash
npm run build
node --input-type=module -e "import('./dist/config.js').then(m => console.log(JSON.stringify(m.DEFAULT_CONFIG.capture.classifier, null, 2)))"
```

- Build: zero errors.
- The echo must print a `seed_rules` object with all three booleans `true`.

**STOP AND REPORT:** config surface extended; defaults present.

---

## Phase 4 — Issue 3b: Classifier Predicates

Add three predicate functions to `classify.ts` and the early-exit block in `classifyCommit`. Add a new optional `gitignoreDiff` parameter (mirroring `packageJsonDiff`). Keep `classifyCommit` a pure function — no I/O inside it.

### File: `src/capture/classify.ts`

**Edit 1 — add `GitignoreDiff` export type** (in the `// ── Types ──` section, after `ParsedPackageJson`):

```ts
export interface GitignoreDiff {
  added_lines: number;
  removed_lines: number;
}
```

**Edit 2 — add lockfile and IDE-config constants** near the other pattern constants (below `DEFAULT_BACKUP_PATTERNS`, line 129):

```ts
// v1.2.2 seed-rule constants
const LOCKFILE_MANIFEST_MAP: Record<string, string> = {
  "package-lock.json": "package.json",
  "yarn.lock": "package.json",
  "pnpm-lock.yaml": "package.json",
  "poetry.lock": "pyproject.toml",
  "Cargo.lock": "Cargo.toml",
  "Gemfile.lock": "Gemfile",
  "go.sum": "go.mod",
};

const IDE_CONFIG_PREFIXES: readonly string[] = [
  ".vscode/",
  ".idea/",
  ".fleet/",
  ".devcontainer/",
];
// NOTE: .github/ is intentionally excluded — it contains CI workflows which
// are classifiable material (not per-developer config).
```

**Edit 3 — add the three predicate functions** (in the `// ── Tier 1 Detectors ──` region, below `isEditorBackup`):

```ts
// ── Seed Rules (v1.2.2) ──────────────────────────────────────────────────────
// Each predicate is whole-commit: returns shouldSuppress=true only if the
// ENTIRE changeset matches the rule's conditions. First match wins; reason is
// logged via console.error for the inbox diagnostic trail.

export interface SeedRuleOutcome {
  shouldSuppress: boolean;
  reason: string;
}

function isGitignoreTrivialCommit(
  meaningful: string[],
  gitignoreDiff: GitignoreDiff | null | undefined,
): SeedRuleOutcome {
  // Only fires when every meaningful file is .gitignore AND the diff is
  // a single-line add/remove. If gitignoreDiff is null/undefined (hook did
  // not bother to compute it), the rule does NOT suppress.
  const gitignoreOnly =
    meaningful.length > 0 &&
    meaningful.every((f) => {
      const parts = normLower(f).split("/");
      return parts[parts.length - 1] === ".gitignore";
    });
  if (!gitignoreOnly) {
    return { shouldSuppress: false, reason: "not gitignore-only" };
  }
  if (!gitignoreDiff) {
    return { shouldSuppress: false, reason: "gitignore diff not available" };
  }
  const totalLines = gitignoreDiff.added_lines + gitignoreDiff.removed_lines;
  if (totalLines !== 1) {
    return { shouldSuppress: false, reason: `gitignore multi-line (${totalLines} lines)` };
  }
  return { shouldSuppress: true, reason: "gitignore_trivial: single-line .gitignore change" };
}

function isIdeConfigOnlyCommit(meaningful: string[]): SeedRuleOutcome {
  if (meaningful.length === 0) {
    return { shouldSuppress: false, reason: "no files" };
  }
  const allIde = meaningful.every((f) => {
    const n = normLower(f);
    return IDE_CONFIG_PREFIXES.some((p) => n.startsWith(p));
  });
  if (!allIde) {
    return { shouldSuppress: false, reason: "not IDE-config-only" };
  }
  return { shouldSuppress: true, reason: "ide_config_only: all files under per-developer IDE config dirs" };
}

function isLockfileOnlyCommit(meaningful: string[]): SeedRuleOutcome {
  if (meaningful.length === 0) {
    return { shouldSuppress: false, reason: "no files" };
  }

  // Compute { parentDir, basename } for every file.
  // v1.2.2 council C4: basename-only comparison is path-insensitive and
  // breaks on monorepos. Compare lockfiles to their MATCHING-DIRECTORY
  // manifests, not to any manifest anywhere in the changeset.
  type FileEntry = { dir: string; base: string };
  const entries: FileEntry[] = meaningful.map((f) => {
    const n = norm(f);
    const parts = n.split("/");
    return {
      base: parts[parts.length - 1],
      dir: parts.slice(0, -1).join("/"),
    };
  });

  // Every file must be a known lockfile (by basename).
  const allLockfiles = entries.every((e) => e.base in LOCKFILE_MANIFEST_MAP);
  if (!allLockfiles) {
    return { shouldSuppress: false, reason: "not lockfile-only" };
  }

  // For EACH lockfile, the MATCHING manifest in the SAME directory must be absent.
  // If any lockfile has its sibling manifest in the changeset, do NOT suppress —
  // that's a dependency-change commit, handled by the existing Tier 1 detector.
  const byPath = new Set(entries.map((e) => (e.dir ? `${e.dir}/${e.base}` : e.base)));
  for (const entry of entries) {
    const manifestBase = LOCKFILE_MANIFEST_MAP[entry.base];
    const manifestPath = entry.dir ? `${entry.dir}/${manifestBase}` : manifestBase;
    if (byPath.has(manifestPath)) {
      return { shouldSuppress: false, reason: `manifest present in same directory — dependency change for ${entry.dir || "root"}` };
    }
  }
  return { shouldSuppress: true, reason: "lockfile_only: lockfiles without matching-directory manifests" };
}
```

**Edit 4 — extend `classifyCommit` signature** (line 193). Add the optional trailing parameter:

**OLD (line 193-200):**
```ts
export function classifyCommit(
  changedFiles: string[],
  deletedFiles: string[],
  addedFiles: string[],
  commitMessage: string,
  config: LedgerConfig,
  packageJsonDiff?: ParsedPackageJson | null,
): ClassifyResult[] {
```

**NEW:**
```ts
export function classifyCommit(
  changedFiles: string[],
  deletedFiles: string[],
  addedFiles: string[],
  commitMessage: string,
  config: LedgerConfig,
  packageJsonDiff?: ParsedPackageJson | null,
  gitignoreDiff?: GitignoreDiff | null,
): ClassifyResult[] {
```

**Edit 5 — insert the seed-rule early-exit block** between line 222 (`if (meaningful.length === 0) return [];`) and line 224 (`const results: ClassifyResult[] = [];`):

```ts
  if (meaningful.length === 0) return [];

  // v1.2.2 seed rules — whole-commit suppressions. Evaluated in declared
  // order: gitignore_trivial → ide_config_only → lockfile_only. First match
  // wins; classifier returns [] to signal "not actionable, do not inbox".
  const seedRules = config.capture.classifier?.seed_rules;
  if (seedRules?.gitignore_trivial ?? true) {
    const outcome = isGitignoreTrivialCommit(meaningful, gitignoreDiff);
    if (outcome.shouldSuppress) {
      console.error(`[context-ledger:classify] suppressed: ${outcome.reason}`);
      return [];
    }
  }
  if (seedRules?.ide_config_only ?? true) {
    const outcome = isIdeConfigOnlyCommit(meaningful);
    if (outcome.shouldSuppress) {
      console.error(`[context-ledger:classify] suppressed: ${outcome.reason}`);
      return [];
    }
  }
  if (seedRules?.lockfile_only ?? true) {
    const outcome = isLockfileOnlyCommit(meaningful);
    if (outcome.shouldSuppress) {
      console.error(`[context-ledger:classify] suppressed: ${outcome.reason}`);
      return [];
    }
  }

  const results: ClassifyResult[] = [];
```

(Keep the `console.error` diagnostic — stdout is reserved for MCP JSON-RPC per the project rules; stderr is fair game for the hook.)

### Validation gate

```bash
npm run build
npm run test:classify
grep -c 'seed_rules' src/capture/classify.ts
```

- Build: zero errors.
- `test:classify`: existing 6 tests pass unchanged (trailing optional parameter preserves signature compatibility).
- grep count: must be ≥ 3 (type + check block uses).

**STOP AND REPORT:** predicates landed, config-gated; existing tests green.

---

## Phase 5 — Issue 3c: Hook Wiring for Gitignore Diff

Compute `GitignoreDiff` in the hook — but only when `.gitignore` is the sole file in `diff.all`. Thread the result into `classifyCommit`. Preserves the <100ms budget: the new git call fires at most once per commit and only on gitignore-only commits.

### File: `src/capture/hook.ts`

**Edit 1 — import the new type.** Locate the existing import line that brings in `classifyCommit` and `ParsedPackageJson` from `./classify.js`. **Merge** `GitignoreDiff` into the same import (do not add a second import line from the same module). Pattern example:

```ts
import { classifyCommit, type ParsedPackageJson, type GitignoreDiff } from "./classify.js";
```

(Adjust to match the exact syntax already in use — it may be `import type { ... }` or a mixed `import { ..., type X }` form. Merge, don't duplicate.)

**Edit 2 — add a `parseGitignoreDiff` helper** after `parsePackageJsonDiff` (line 274) and before `parseEnvChanges`. Model on `parsePackageJsonDiff`: try/catch, `execSync`, fail-open return `null`.

**Council C5 fix — guard against initial-commit failure**. `git diff HEAD~1 HEAD ...` fails at repo-root commit because `HEAD~1` does not exist. The try/catch would catch the error, but the failing git invocation emits a `fatal:` line to stderr, conflicting with the stderr diagnostic channel. Pre-check with `git rev-parse --verify HEAD~1^{commit}` and silence its own stderr before the diff call.

**Council C1 fix — accept any `.gitignore` in the tree** (not just the repo root). The helper takes a `path` argument to keep hook and classifier aligned:

```ts
function parseGitignoreDiff(projectRoot: string, path: string): GitignoreDiff | null {
  try {
    // Guard: HEAD~1 may not exist on the initial commit. Silence stderr
    // so a missing parent doesn't pollute the diagnostic channel.
    execSync("git rev-parse --verify HEAD~1^{commit}", {
      cwd: projectRoot,
      stdio: ["ignore", "ignore", "ignore"],
    });

    // git diff --numstat HEAD~1 HEAD -- <path>
    // Output format: "<added>\t<removed>\t<path>" (tab-separated).
    // For binary/non-text diffs git emits "-\t-\t<path>" — parseInt("-")
    // returns NaN, caught by Number.isFinite below → returns null.
    const raw = execSync(`git diff --numstat HEAD~1 HEAD -- "${path}"`, {
      cwd: projectRoot,
      encoding: "utf8",
      stdio: "pipe",
    }).trim();
    if (!raw) return { added_lines: 0, removed_lines: 0 };
    const parts = raw.split(/\s+/);
    const added = parseInt(parts[0], 10);
    const removed = parseInt(parts[1], 10);
    if (!Number.isFinite(added) || !Number.isFinite(removed)) return null;
    return { added_lines: added, removed_lines: removed };
  } catch {
    return null;
  }
}
```

**Edit 3 — gate the helper call and pass the result to `classifyCommit`.** Locate the existing pkgDiff block (lines 365-373). Extend it with subdirectory-aware gating (council C1):

**OLD:**
```ts
    // 8. Parse high-value file diffs + classify
    const pkgDiff = diff.all.some((f) => f.endsWith("package.json"))
      ? parsePackageJsonDiff(projectRoot)
      : null;

    const envChanges = diff.all.some((f) => f.includes(".env"))
      ? parseEnvChanges(projectRoot)
      : null;

    const results = classifyCommit(diff.all, diff.deleted, diff.added, subject, config, pkgDiff);
```

**NEW:**
```ts
    // 8. Parse high-value file diffs + classify
    const pkgDiff = diff.all.some((f) => f.endsWith("package.json"))
      ? parsePackageJsonDiff(projectRoot)
      : null;

    const envChanges = diff.all.some((f) => f.includes(".env"))
      ? parseEnvChanges(projectRoot)
      : null;

    // v1.2.2 council C1 — compute gitignore diff when a .gitignore anywhere
    // in the tree is the ONLY file (root or subdirectory). The hook gate and
    // the classifier predicate must agree on "sole .gitignore" semantics;
    // here, both use basename === ".gitignore".
    // Keeps the hook under 100ms: the extra git call fires at most once per
    // commit, only for gitignore-only commits.
    const soleGitignorePath =
      diff.all.length === 1 && diff.all[0].toLowerCase().split("/").pop() === ".gitignore"
        ? diff.all[0]
        : null;
    const gitignoreDiff = soleGitignorePath ? parseGitignoreDiff(projectRoot, soleGitignorePath) : null;

    const results = classifyCommit(diff.all, diff.deleted, diff.added, subject, config, pkgDiff, gitignoreDiff);
```

### Validation gate

```bash
npm run build
npm run test:hook
grep -n 'parseGitignoreDiff' src/capture/hook.ts
```

- Build: zero errors.
- `test:hook`: passes.
- grep: at least two hits (definition + call site).

**STOP AND REPORT:** hook wiring complete; gitignore diff threaded only on gitignore-only commits.

---

## Phase 6 — Issue 3d: Seed Rule Tests + Test-Runner Wiring

**Council C6 — test-runner wiring first.** Phase 0 confirmed that `package.json`'s `test:classify` script runs `dist/capture/smoke-test.js` ONLY. `src/capture/classify.test.ts` exists but is NOT in the npm chain — its 6 tests are currently dead code. Before adding more tests, wire both files into `test:classify`.

### File: `package.json`

**Edit — extend `test:classify`** (keep existing smoke-test invocation; append the `.test` runner):

**OLD:**
```json
"test:classify": "node dist/capture/smoke-test.js",
```

**NEW:**
```json
"test:classify": "node dist/capture/smoke-test.js && node dist/capture/classify.test.js",
```

This preserves all existing smoke-test coverage and now runs `classify.test.ts` too.

### File: `src/capture/classify.test.ts`

Add these six test functions (follow the existing `testN_...` style). Each calls `classifyCommit` with the new optional `gitignoreDiff` 7th positional parameter where needed.

```ts
// ── Seed Rule Tests (v1.2.2) ─────────────────────────────────────────────────

async function test7_gitignoreTrivialSuppressed(): Promise<void> {
  console.error("\nTest 7: .gitignore-only single-line commit is suppressed");
  const config = makeConfig();
  const all = [".gitignore"];
  const results = classifyCommit(all, [], [], "chore: ignore dist", config, null, {
    added_lines: 1,
    removed_lines: 0,
  });
  assert(results.length === 0, "gitignore-only single-line commit produces no results");
}

async function test8_gitignoreMixedNotSuppressed(): Promise<void> {
  console.error("\nTest 8: .gitignore + real source change NOT suppressed by gitignore_trivial");
  // Toggle the rule off and compare — the rule's behavior contribution on a
  // mixed commit must be zero. Works regardless of what other classifiers emit.
  const all = [".gitignore", "src/real.ts"];
  const del: string[] = [];
  const add = ["src/real.ts"];
  const on = makeConfig();
  const off = makeConfig();
  off.capture.classifier!.seed_rules = { gitignore_trivial: false };
  const resultsOn = classifyCommit(all, del, add, "feat: add real", on, null, {
    added_lines: 1,
    removed_lines: 0,
  });
  const resultsOff = classifyCommit(all, del, add, "feat: add real", off, null, null);
  assert(
    JSON.stringify(resultsOn) === JSON.stringify(resultsOff),
    "gitignore_trivial does not affect mixed commits (toggle has no effect)",
  );
}

async function test9_ideConfigOnlySuppressed(): Promise<void> {
  console.error("\nTest 9: IDE-config-only commit is suppressed");
  const config = makeConfig();
  // Mix forward- and back-slash paths to exercise normLower's Windows portability
  // (council S4 regression assertion — normLower at classify.ts:24 replaces \\ with /).
  const all = [".vscode/settings.json", ".idea\\workspace.xml"];
  const results = classifyCommit(all, [], [], "chore: ide", config, null, null);
  assert(results.length === 0, "IDE-config-only commit (mixed separators) produces no results");
}

async function test10_ideConfigWithGithubNotSuppressed(): Promise<void> {
  console.error("\nTest 10: .github/ workflow change is NOT caught by ide_config_only");
  const all = [".github/workflows/ci.yml"];
  const on = makeConfig();
  const off = makeConfig();
  off.capture.classifier!.seed_rules = { ide_config_only: false };
  const resultsOn = classifyCommit(all, [], [], "ci: add workflow", on, null, null);
  const resultsOff = classifyCommit(all, [], [], "ci: add workflow", off, null, null);
  assert(
    JSON.stringify(resultsOn) === JSON.stringify(resultsOff),
    "ide_config_only does not fire on .github/ path",
  );
}

async function test11_lockfileOnlySuppressed(): Promise<void> {
  console.error("\nTest 11: lockfile-only commit (no manifest) is suppressed");
  const config = makeConfig();
  const all = ["package-lock.json"];
  const results = classifyCommit(all, [], [], "chore: bump lockfile", config, null, null);
  assert(results.length === 0, "lockfile-only commit produces no results");
}

async function test12_lockfileWithManifestNotSuppressed(): Promise<void> {
  console.error("\nTest 12: lockfile + matching-directory manifest classifies as dependency change");
  const config = makeConfig();
  // Both files at repo root, same directory. The existing dependency-addition
  // detector (Tier 1) emits change_category "dependency-addition" with only
  // package.json in changed_files (not package-lock.json). Council S6 note.
  const all = ["package-lock.json", "package.json"];
  const results = classifyCommit(all, [], [], "chore: add dep", config, {
    addedDeps: ["foo@1.0.0"],
    removedDeps: [],
    otherChanges: false,
  }, null);
  assert(results.length > 0, "manifest + lockfile produces at least one classification");
  assert(
    results.some((r) => r.change_category === "dependency-addition"),
    "dependency-addition result emitted",
  );
}

async function test13_lockfileMonorepoSiblingManifest(): Promise<void> {
  // Council C4 regression: a lockfile in packages/a and an UNRELATED manifest
  // in packages/b should NOT block suppression for packages/a. The dir-pair
  // comparison ensures only matching-directory manifests count.
  //
  // Here: packages/a/package-lock.json changes + packages/b/pyproject.toml
  // changes. The lockfile's matching manifest is packages/a/package.json,
  // which is ABSENT. `all`-lockfiles check fails because pyproject.toml is
  // not in LOCKFILE_MANIFEST_MAP, so the rule returns shouldSuppress=false
  // with reason "not lockfile-only" — and classification proceeds.
  console.error("\nTest 13: monorepo lockfile + unrelated manifest — mixed, rule skips");
  const config = makeConfig();
  const all = ["packages/a/package-lock.json", "packages/b/pyproject.toml"];
  const on = makeConfig();
  const off = makeConfig();
  off.capture.classifier!.seed_rules = { lockfile_only: false };
  const resultsOn = classifyCommit(all, [], [], "chore: mixed monorepo", on, null, null);
  const resultsOff = classifyCommit(all, [], [], "chore: mixed monorepo", off, null, null);
  assert(
    JSON.stringify(resultsOn) === JSON.stringify(resultsOff),
    "lockfile_only does not fire on mixed-type monorepo commit",
  );
}

async function test14_deepMergeBooleanOverride(): Promise<void> {
  // Council I3: verify a user config of { seed_rules: { gitignore_trivial: false } }
  // deep-merges to { gitignore_trivial: false, ide_config_only: true, lockfile_only: true }.
  // Regression guard against deepMerge mishandling explicit `false` as falsy.
  console.error("\nTest 14: deepMerge preserves explicit false override on seed_rules");
  const config = makeConfig();
  // Simulate what loadConfig produces after deepMerge on a partial user override:
  config.capture.classifier = {
    editor_backup_patterns: config.capture.classifier!.editor_backup_patterns,
    seed_rules: { gitignore_trivial: false, ide_config_only: true, lockfile_only: true },
  };
  // gitignore-only single-line commit. With gitignore_trivial disabled the rule
  // should NOT fire; the commit falls through to normal classification.
  const all = [".gitignore"];
  const off = makeConfig();
  off.capture.classifier!.seed_rules = { gitignore_trivial: false };
  const resultsOff = classifyCommit(all, [], [], "chore: ignore", off, null, { added_lines: 1, removed_lines: 0 });
  // Compare against the case where gitignore_trivial is explicitly true:
  const on = makeConfig();
  on.capture.classifier!.seed_rules = { gitignore_trivial: true };
  const resultsOn = classifyCommit(all, [], [], "chore: ignore", on, null, { added_lines: 1, removed_lines: 0 });
  assert(resultsOn.length === 0, "with gitignore_trivial=true, rule suppresses");
  assert(
    JSON.stringify(resultsOff) !== JSON.stringify(resultsOn),
    "with gitignore_trivial=false, rule does not suppress (differs from on-case)",
  );
}
```

Register in `main()`:

```ts
  await test7_gitignoreTrivialSuppressed();
  await test8_gitignoreMixedNotSuppressed();
  await test9_ideConfigOnlySuppressed();
  await test10_ideConfigWithGithubNotSuppressed();
  await test11_lockfileOnlySuppressed();
  await test12_lockfileWithManifestNotSuppressed();
  await test13_lockfileMonorepoSiblingManifest();
  await test14_deepMergeBooleanOverride();
```

### Validation gate

```bash
npm run build
npm run test:classify
```

- Build: zero errors.
- `test:classify`: `smoke-test.js` runs all existing cases, then `classify.test.js` runs 6+8 = 14 tests, 0 failed.

**STOP AND REPORT:** seed-rule tests passing.

---

## Phase 7 — Docs, Version, Design Spec

### File: `package.json`

Bump version:

**OLD (line 3):** `"version": "1.2.1",`
**NEW:** `"version": "1.2.2",`

### File: `CHANGELOG.md`

Prepend (at the top, after the `# Changelog` heading, above the `## v1.2.1` entry). Match the v1.2.1 entry's exact formatting — em-dash in the header, bullet-per-module, `**module**: prose.` shape. Use today's date.

```markdown
## v1.2.2 — 2026-04-19

- **retrieval**: Cross-scope supersede history now surfaces in `recently_superseded` when the replacement record is in the query scope, even at default params (`include_superseded: false`). Cross-scope entries are scoped-by-definition to the query (their replacement is in scope) and are genealogy rather than stale history. Same-scope superseded records continue to require `include_superseded: true`. Opt out per query via the new `include_cross_scope_supersede: false` parameter (default `true`). One-hop traversal only. New `MatchReason` value `cross_scope_supersede` marks these entries.
- **retrieval**: `deriveScope` now returns `{ type: "directory", id: "packages/<pkg>", source: "monorepo_root" }` for file paths under common monorepo roots (`packages/`, `apps/`, `services/`) when no `scope_mappings` entry matches. Previously returned the basename via `directory_fallback`. Behavior improvement: `derived_scope` reported in the decision pack is now useful on monorepo paths. Original `directory_fallback` preserved for non-monorepo paths. The `inboxItemIntersectsScope` mirror in `src/retrieval/query.ts` was updated in lockstep — `mistakes_in_scope` and dismissed-inbox entries now resolve correctly on monorepo-root queries.
- **classify**: Three new deterministic seed rules suppress whole-commit classification when the changeset is non-actionable. Configurable via `capture.classifier.seed_rules.{gitignore_trivial, ide_config_only, lockfile_only}` — all default `true`. `gitignore_trivial` fires when any `.gitignore` (root or subdirectory) is the only file in the commit and the diff is a single-line add/remove. `ide_config_only` fires when every file lives under `.vscode/`, `.idea/`, `.fleet/`, or `.devcontainer/` (`.github/` deliberately excluded to preserve CI workflow classification). `lockfile_only` fires when only lockfiles change (`package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`, `poetry.lock`, `Cargo.lock`, `Gemfile.lock`, `go.sum`) with no matching-directory manifest in the changeset — per-directory comparison so monorepo sibling packages don't false-negative the rule. Hook adds a single conditional `git diff --numstat` call, fired only when a sole `.gitignore` is present and `HEAD~1` exists — budget preserved.
- **mcp**: `query_decisions` tool input schema gains `include_cross_scope_supersede?: boolean` (default `true`). Tool annotations (`readOnlyHint`, `destructiveHint`, `openWorldHint`) unchanged.
- **config**: `ClassifierCaptureConfig` gains `seed_rules?: SeedRulesConfig`. Additive — existing configs continue to work with defaults filled in via `deepMerge`.
- **schema**: Purely additive. No changes to `ledger.jsonl` event schema. No changes to MCP tool annotations. No new runtime dependencies.
- **spec**: `context-ledger-design-v2.md` bumped v2.4.1 → v2.4.2 with three decision-table entries (Source: `dogfood 2026-04-19 to 2026-04-20`).
```

### File: `context-ledger-design-v2.md`

**Edit 1 — bump version header on line 1.**

**OLD:** `# context-ledger: Design Document v2.4.1`
**NEW:** `# context-ledger: Design Document v2.4.2`

**Edit 2 — append three decision-table rows.** Insert between line 949 (the last existing row — v2.4.1 editor-backup entry) and line 951 (the `---` separator). Keep the existing `| Decision | Rationale | Source |` column order.

```markdown
| Cross-scope supersede traversal in `recently_superseded` (one hop via `replaced_by`), surfaced at default params. | Audit trails where a narrower-scoped decision is superseded by a broader one were invisible when querying by the broader scope. These entries are genealogy of the in-scope record, not stale history, so they surface even when `include_superseded: false`. Same-scope supersedes continue to require the flag. Opt-out per query via new `include_cross_scope_supersede: false` param (default `true`). One-hop traversal, no chaining, no new event types. | dogfood 2026-04-19 to 2026-04-20 |
| Monorepo-root fallback in `deriveScope` for `packages/`, `apps/`, `services/` paths. | Previously basenames like `report-generator.ts` were returned as scope ids, which is misleading in decision-pack output. New `monorepo_root` source returns `packages/<pkg>` form. | dogfood 2026-04-19 to 2026-04-20 |
| Three seed-rule classifier suppressions (`gitignore_trivial`, `ide_config_only`, `lockfile_only`), config-gated, default on. | These commits carry no decision value and were polluting the inbox and the future learning layer's rejection signal. Deterministic suppressions fire at N=0 for every user from commit #1. | dogfood 2026-04-19 to 2026-04-20 |
```

**Edit 3 — update the narrative fallback-order prose** (council S3). The spec currently describes the order at two places:

- `context-ledger-design-v2.md` line ~479 (Retrieval contract, step 2):
  > "If `file_path` is provided, the server derives scope by consulting `scope_mappings` in config, then `scope_aliases` in existing records, then falling back to the top-level directory name as scope ID."

  Update to:
  > "If `file_path` is provided, the server derives scope by consulting `scope_mappings` in config, then `scope_aliases` in existing records, then the **monorepo-root fallback** (returns `packages/<pkg>` for paths under `packages/`, `apps/`, or `services/`), then falling back to the top-level directory name as scope ID."

- `context-ledger-design-v2.md` line ~482 (step 3.2 of query-only fallback order):
  > "`file_path`-derived scope via `scope_mappings` → `scope_aliases` → directory fallback"

  Update to:
  > "`file_path`-derived scope via `scope_mappings` → `scope_aliases` → `monorepo_root` → directory fallback"

If `docs/ARCHITECTURE.md` (agent-guard-managed) duplicates this list, Phase 9 `agent-guard sync` will regenerate it from source and may need a doc-target template tweak. Verify in Phase 9.

### Validation gate

```bash
npm run build
grep '"version"' package.json
grep -n 'v2.4.2' context-ledger-design-v2.md
grep -n 'v1.2.2' CHANGELOG.md
```

- Build: zero errors.
- Version is `1.2.2`.
- Design spec shows `v2.4.2` on line 1 and three new rows above line 951.
- CHANGELOG has the new entry at the top.

**STOP AND REPORT:** docs, version, and spec updated.

---

## Phase 8 — Full Validation

Final sweep across the entire test suite and a light dogfood check.

### Steps

1. Clean build:
   ```bash
   npm run build
   ```

2. Full test suite:
   ```bash
   npm test
   ```
   All of `test:integration`, `test:retrieval`, `test:mcp`, `test:classify`, `test:drafter`, `test:hook` must pass. Expect new passing counts in `test:retrieval` (+2) and `test:classify` (+6).

3. Grep safety checks — verify no regressions slipped through:
   ```bash
   grep -rn '"cross_scope_supersede"' src/
   grep -rn '"monorepo_root"' src/
   grep -rn 'seed_rules' src/
   ```
   Each must produce expected hits (cross_scope_supersede: packs.ts + query.ts + smoke-test; monorepo_root: scope.ts + smoke-test; seed_rules: classify.ts + config.ts + classify.test.ts).

4. Import-hygiene check — confirm no duplicate imports:
   ```bash
   grep -E '^import' src/capture/hook.ts | sort | uniq -d
   grep -E '^import' src/retrieval/scope.ts | sort | uniq -d
   grep -E '^import' src/capture/classify.ts | sort | uniq -d
   ```
   Each must produce zero output. If any line repeats, merge the imports before proceeding.

5. Quick dogfood (manual): run `node dist/cli.js query "analyst-bot"` against the dashboard ledger (or whichever local ledger exists) and confirm `recently_superseded` now includes cross-scope entries when they exist. This is an eyeball check, not a gate — do not block the phase if the ledger has no such pair.

### Validation gate

```bash
npm run build && npm test
```

Both pass.

**STOP AND REPORT:** full suite green, imports clean.

---

## Phase 9 — Agent-Guard Sync

Final doc sync.

### Steps

1. Run:
   ```bash
   npx agent-guard sync
   ```

2. Review the diff against source-of-truth files. If agent-guard touches generated docs (`docs/_generated/`), accept. If it touches narrative docs (`docs/ARCHITECTURE.md`), review carefully — the spec updates already happened in Phase 7.

3. Stage any doc updates produced by sync. Do not run the commit here — the user will commit when they've reviewed everything.

### Validation gate

```bash
git status --porcelain
```

Only expected files should be dirty (source files from earlier phases, CHANGELOG, package.json, context-ledger-design-v2.md, plus any agent-guard-managed files).

**STOP AND REPORT:** docs synced, ready for commit.

---

## Phase 10 — Ready to Ship

Final checklist before the user commits:

- [ ] `git diff` review covers: `src/retrieval/scope.ts`, `src/retrieval/packs.ts`, `src/retrieval/query.ts`, `src/retrieval/smoke-test.ts`, `src/capture/classify.ts`, `src/capture/classify.test.ts`, `src/capture/hook.ts`, `src/config.ts`, `package.json`, `CHANGELOG.md`, `context-ledger-design-v2.md`, plus agent-guard-managed docs.
- [ ] No new files in `src/` beyond existing structure (all edits are in-place).
- [ ] Zero new runtime dependencies in `package.json`.
- [ ] MCP tool annotations untouched (`grep -rn 'readOnlyHint\|destructiveHint\|openWorldHint' src/mcp/` unchanged from baseline).
- [ ] `npm run build` clean.
- [ ] `npm test` all green.

Once the user commits, the post-commit hook itself will exercise the new seed rules and the gitignore numstat path — a real-world budget check.

**STOP.** Report completion. Wait for user to commit.

---

## Refinement Log (council feedback + human-gate resolutions)

Folded into the guide above:

| # | Source | Change |
|---|---|---|
| **C1** | Both reviewers + Q3 | Hook gate + classifier predicate agree: any `.gitignore` basename anywhere in the tree, when it's the sole file. Hook passes the actual path to `git diff --numstat`. |
| **C2** | Codex | `inboxItemIntersectsScope` in `src/retrieval/query.ts` has its own copy of the path-derivation chain. Phase 1 updates BOTH sites — `deriveScope` in `scope.ts` AND the mirror in `query.ts`. Validation gate greps both files. |
| **C3** | Codex | `includeSuperseded` resolved once in `queryDecisions` (`params.include_superseded ?? config.retrieval.include_superseded`) and passed to `buildDecisionPack` via 7th param. Phase 2 Test 4 is the regression guard. |
| **C4** | Codex | `isLockfileOnlyCommit` compares `{parentDir, basename}` tuples. Matching manifest must be absent IN THE SAME DIRECTORY. Phase 6 Test 13 covers monorepo sibling manifest. |
| **C5** | Gemini | `parseGitignoreDiff` guards with `git rev-parse --verify HEAD~1^{commit}` (stderr silenced) before numstat. Fail-open preserved; no `fatal:` noise on initial commits. |
| **C6** | Gemini | Phase 0 verifies `test:classify` wiring. Phase 6 chains `smoke-test.js && classify.test.js` — previously `classify.test.ts` was dead code. |
| **S2** | Gemini | Dangling-pointer guard carries explanatory comment. |
| **S3** | Gemini | Phase 7 Edit 3 updates narrative fallback-order prose at design-spec lines ~479 and ~482. |
| **S4** | Gemini | Test 9 exercises mixed forward/back slashes. |
| **S5** | Codex | `parseGitignoreDiff` comment documents the `-` binary-diff fallthrough to `null`. |
| **S6** | Codex | Test 12 comment confirms `"dependency-addition"` category; `package-lock.json` not in `changed_files`. |
| **S7** | Codex | Cross-scope branch carries "do NOT hoist" comment. |
| **I3** | Gemini | Phase 6 Test 14 asserts `deepMerge` preserves explicit `false` on `seed_rules.gitignore_trivial`. |
| **Q1** | Human | Keep `cross_scope_supersede`. Describes the match mechanism (traversed a supersede boundary), consistent with `scope_hit` / `file_path_hit` / `tag_match` / `broad_fallback`. `replacement_scope_hit` would lose the supersede-genealogy cue. |
| **Q2** | Human (override) | **Cross-scope supersedes surface at default params.** Genealogy of the in-scope record is not stale history. Same-scope supersedes still require `include_superseded: true`. Escape hatch: new per-query `include_cross_scope_supersede?: boolean` (default `true`) wired through filter, `buildDecisionPack`, and the MCP Zod schema. No new config-level field. CHANGELOG + design-spec row updated to call this out explicitly as a behavior change. |
| **Q3** | Human | `gitignore_trivial` fires any-tree, not root-only. Budget impact negligible. |

### Design recommendations applied per council:

- **D2** (one-hop vs multi-hop): keep one hop as per feature spec.
- **D3** (scope id format): keep `{ id: "packages/foo" }` — namespaced.
- **D4** (consult `config.monorepo.*`): no — hardcode `packages/`, `apps/`, `services/`.
- **D5** (replacement state check): no state check — relation stands even if replacement is itself superseded later.

### Suggestions noted but not applied:

- **I1** (generic `fileStats` parameter): out of scope for v1.2.2; revisit for v1.3.0 learning layer.
- **I4** (MCP tool description hint about `replaced_by`): the new Zod description for `include_cross_scope_supersede` now effectively carries this hint; full tool-description polish deferred to v1.3.0.

---

## Human Input Gate — RESOLVED

All three Phase 4 human-gate questions resolved by the user on 2026-04-19. Resolutions are folded into the guide above; this section summarizes the choices for the execution agent's reference.

- **Q1** — Keep `cross_scope_supersede`. (Default accepted. It describes the match mechanism; `replacement_scope_hit` would lose the supersede-genealogy cue.)
- **Q2** — **Override to (B)**. Cross-scope supersedes surface at default params. Rationale: the dogfood bug was observed at default params; under (A) the bug is not actually fixed at default. Cross-scope entries are genealogy of the currently-active record in the query scope, not pack pollution. Same-scope supersedes still require `include_superseded: true`. Escape hatch: new per-query `include_cross_scope_supersede?: boolean` (default `true`) — see Phase 2 Edits 1–6 and the Zod schema edit on `src/mcp/read-tools.ts`. No new config-level field.
- **Q3** — Accept default. `gitignore_trivial` fires any-tree. Monorepos routinely ship per-package `.gitignore`; root-only would silently miss the common case. Budget impact negligible — numstat call only fires on sole-`.gitignore` commits.

---

Ready to execute. Run `/compact` to free context, then in a fresh Claude Code instance execute `agentic_implementation_guide.md` phase by phase.

---

## Phase 11 — Self-Audit Gate (Go/No-Go Report)

### Goal

At the end of execution, produce a structured go/no-go report matching the format used for v1.2.0 and v1.2.1 audits. Phase 10 confirms the tree compiles and tests pass; Phase 11 confirms the tree is actually publishable. Do NOT run git commit. Do NOT run npm version. Do NOT run npm publish. Produce the report and stop.

### Steps

1. **Working tree hygiene.** Run `git status` and `git diff --stat`. Categorize every modified/untracked file into:
   - (a) v1.2.2 feature (the 10 files modified per the guide: packs.ts, query.ts, scope.ts, config.ts, classify.ts, hook.ts, smoke-test.ts files, classify.test.ts, CHANGELOG.md, context-ledger-design-v2.md, package.json, read-tools.ts)
   - (b) agent-guard sync exhaust (.agent-guard/log.json, docs/_generated/env-vars.md, possibly docs/ARCHITECTURE.md)
   - (c) /auto-feature planning artifacts (exploration-results.md, agentic_implementation_guide.md, council-feedback.md, triage-results.md, code-inspector-findings.md, pattern-finder-findings.md)
   - (d) anything unexpected
   
   If (d) is non-empty, STOP and report. Do not proceed.

2. **Version NOT pre-bumped.** `node -e "console.log(require('./package.json').version)"` must print `1.2.1`. If it already reads `1.2.2`, STOP — `npm version patch` is a release-driver step, not a guide step.

3. **Diff review of the core source changes.** For each modified source file, paste the full `git diff HEAD -- <file>` output. Verify against the guide's Phase sections:
   - `src/retrieval/packs.ts`: MatchReason union extended with `"cross_scope_supersede"`; buildDecisionPack signature gains `includeCrossScope` param; same-scope vs cross-scope branching correct in recently_superseded assembly.
   - `src/retrieval/query.ts`: cross-scope supersede branch correctly placed in filter loop; includeCrossScopeSupersede param plumbed through; default true at config/param resolution; inboxItemIntersectsScope shares scope-derivation logic with deriveScope (council C2).
   - `src/retrieval/scope.ts`: ScopeSource union gains `"monorepo_root"`; derivation walks packages/ apps/ services/ before directory_fallback.
   - `src/config.ts`: SeedRulesConfig added; ClassifierCaptureConfig gains optional seed_rules; DEFAULT_CONFIG populates all three booleans.
   - `src/capture/classify.ts`: three predicate helpers added; classifyCommit signature gains optional gitignoreDiff param; early-exit checks gated on config.
   - `src/capture/hook.ts`: parseGitignoreDiff helper added; conditional numstat call only when sole file is .gitignore; HEAD~1 rev-parse guard present (council C5); threaded into classifyCommit.
   - `src/mcp/read-tools.ts`: Zod schema for query_decisions gains `include_cross_scope_supersede` optional boolean; tool description updated; annotations `{readOnlyHint: true, destructiveHint: false, openWorldHint: false}` byte-identical to v1.2.1.
   
   Flag any deviation from the guide.

4. **CHANGELOG accuracy.** Open CHANGELOG.md. Confirm:
   - v1.2.2 entry is the first dated entry (above v1.2.1).
   - Contains a bullet explicitly calling out the cross-scope supersede default behavior change with wording along these lines: "Cross-scope supersede history now surfaces in recently_superseded when the replacement record is in the query scope, even at default params. Cross-scope entries are scoped-by-definition to the query (their replacement is in scope) and are genealogy rather than stale history."
   - Documents include_cross_scope_supersede as the per-query escape hatch.
   - Does NOT mention a config-level field for cross-scope toggling (that was deliberately not added).
   - Other bullets cover: monorepo_root scope derivation, three seed rules (gitignore_trivial any-tree, ide_config_only with .github/ exclusion, lockfile_only with tuple-dir matching), new MatchReason value, new ScopeSource value.

5. **Design spec accuracy.** context-ledger-design-v2.md header reads `v2.4.2`. Three new decision-table entries added with Source column `"dogfood 2026-04-19 to 2026-04-20"`. Narrative fallback-order text updated to include monorepo_root between scope_aliases and directory_fallback (council S3).

6. **Real CLI smoke against a seeded ledger.** This is the one check no automated test covers.
   
   Build a seeded `.context-ledger/` in a tempdir with:
   - One active precedent with explicit scope `{type: directory, id: packages/foo}`.
   - One superseded decision scoped `{type: concern, id: foo-planning}`, with a supersede transition pointing to a new active decision scoped `{type: directory, id: packages/foo}`. (Simulates the v1.2.2 cross-scope case.)
   - One dismissed inbox item with a proposed_record scoped `{type: directory, id: packages/foo}` and a rejection_reason (simulates mistakes_in_scope content).
   
   From the tempdir with CONTEXT_LEDGER_PROJECT_ROOT set, run:
   
   - `node <repo>/dist/cli.js query "test"` — paste the output verbatim. Verify derived_scope is monorepo-root-aware (should report packages/foo with source monorepo_root if the tempdir mimics a packages/ layout).
   - `node <repo>/dist/cli.js query --file packages/foo/src/bar.ts` (or equivalent — use whatever flag the CLI supports for file_path queries). Verify recently_superseded contains the cross-scope record with match_reason `cross_scope_supersede`.
   - Re-run with `include_cross_scope_supersede: false` via whatever CLI flag exposes query params (or skip this test and note that CLI may not expose the new param — only MCP does). Verify cross-scope entry drops.
   
   Clean up the tempdir after.

7. **MCP server tools/list sanity.** Spawn `dist/mcp-server-bin.js` as a subprocess. Send initialize + tools/list JSON-RPC requests on stdin. Verify:
   - Same six tools as v1.2.1: query_decisions, propose_decision, confirm_pending, reject_pending, supersede_decision, record_writeback.
   - query_decisions input schema now contains `include_cross_scope_supersede` as an optional boolean.
   - query_decisions annotations byte-identical to v1.2.1: `readOnlyHint: true, destructiveHint: false, openWorldHint: false`.
   - No new tools introduced.
   
   Paste the tools/list response verbatim. Kill subprocess.

8. **Publish readiness.**
   - Run `npm publish --dry-run`. Paste the full tarball file list. Flag src/ leaks, .context-ledger/ leaks, missing dist entries.
   - Test-file cargo (dist/**/*.test.js, dist/**/smoke-test.js, dist/ledger/dogfood.js, dist/smoke-drafter.js) is pre-existing per v1.2.0/v1.2.1 TODO #3 — note but do not flag as regression.
   - Confirm `files` in package.json, `main`, `types`, bin entries still correct.

9. **Commit plan proposal.** Propose three commits in order — do NOT execute:
   - Commit 1 (feature): `git add` the 10-ish source files + CHANGELOG.md + context-ledger-design-v2.md. Proposed conventional-commits message along the lines of `feat(retrieval): cross-scope supersede + monorepo-root scope + classifier seed rules (v1.2.2)` with a body itemizing the three feature areas and explicitly calling out the cross-scope default behavior change.
   - Commit 2 (chore): `git add` .agent-guard/log.json, docs/_generated/env-vars.md, and docs/ARCHITECTURE.md if modified. Message: `chore: sync agent-guard docs`.
   - Commit 3 (docs): `git add` the six /auto-feature planning artifacts. Message: `docs: /auto-feature planning artifacts for v1.2.2`.
   
   Paste the proposed commands and messages. Do NOT run them.

### Validation Gate

Produce a final report in this exact format:

| Phase | Check | Status | Notes |
|-------|-------|--------|-------|

Status column values: PASS, CAVEAT, NO-GO, PROPOSAL (for commit plan).

Final line: one of GO / NO-GO / GO-WITH-CAVEATS.

If GO-WITH-CAVEATS, enumerate every caveat the user should know before running npm version patch.

If NO-GO, list every blocker and the smallest fix for each.

If GO, state verbatim: "Ready for user to execute the Phase 11 commit plan (three commits in order), then `npm version patch`, then `git push origin master --follow-tags`, then `npm publish`. I did not commit, tag, or publish."

### STOP AND REPORT

After the report is produced, halt. Do NOT commit. Do NOT tag. Do NOT push. Do NOT publish. Do NOT run `npm pkg fix`. Do NOT modify any files.
