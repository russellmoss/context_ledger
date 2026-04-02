# Council Feedback — Setup Wizard (src/setup.ts)

## Sources
- OpenAI (gpt-5.4, reasoning_effort: high)
- Gemini (gemini-3.1-pro-preview, thinking: high)

---

## CRITICAL

### C1: isCancel() must be checked after every @clack/prompts call (GPT + Gemini)
Both reviewers flagged this. `confirm()` and `multiselect()` return a symbol on Ctrl+C. Without `isCancel()` checks, the wizard will either crash or silently write garbage to config. The guide mentions importing `isCancel` and has a general cancel pattern, but does not explicitly mandate it at every prompt site.

**Fix**: Add explicit `isCancel()` check after every `confirm()` and `multiselect()` call. On cancel, call `cancel("Setup cancelled.")` and return.

### C2: loadConfig() may return shared DEFAULT_CONFIG singleton — mutation trap (GPT)
If `loadConfig()` returns `DEFAULT_CONFIG` directly on ENOENT (no deep clone), mutating the returned object mutates the shared default for the process lifetime.

**Fix**: Verify that `loadConfig()` returns a fresh deep-merged clone (it uses `deepMerge` which creates new objects). If DEFAULT_CONFIG is returned directly on ENOENT, add a clone. [NEEDS VERIFICATION — check config.ts deepMerge behavior on ENOENT path]

### C3: Config directory must be created before writing config.json (GPT + Gemini)
Step 2 writes to `configPath(projectRoot)` but the `.context-ledger/` directory may not exist on first run. Guide imports `mkdir` but doesn't state to call it before `writeFile`.

**Fix**: Add `await mkdir(ledgerDir(projectRoot), { recursive: true })` before writing config. [NOTE: Guide actually includes this — see "await mkdir(ledgerDir(projectRoot), { recursive: true })" in Step 2. This is already addressed.]

### C4: Windows path normalization for scope_mappings keys (GPT + Gemini)
`readdir()` on Windows returns backslash paths. Config spec uses forward slashes (`src/path/`). Without normalization, scope matching will fail.

**Fix**: Normalize all paths to forward slashes before using as config keys: `path.split("\\").join("/")`. Ensure trailing slash on directory paths.

### C5: Step 3 hook logic duplication vs extraction (GPT + Gemini)
Both reviewers flagged that reimplementing hook detection in setup.ts will drift from cli.ts. GPT recommends extracting to shared module. Gemini agrees.

**Assessment**: The guide intentionally reimplements because the UI is different (@clack/prompts vs console.log). However, the DETECTION logic should be shared. The INSTALLATION logic differs in UI output. Recommended: extract hook detection into a shared helper that returns a HookSystem type, keep installation separate with different UI.

### C6: Step 5 uses raw readLedger() instead of materialized state (GPT)
`readLedger()` returns all events including transitions and non-decision events. Checking `.length > 0` doesn't mean there are active decisions. A ledger with only superseded decisions would show misleading results.

**Fix**: Use `foldLedger()` to get materialized state, then check if any decisions have `state === "active"`. Or simply try `queryDecisions()` and check if `active_precedents.length > 0`.

### C7: queryDecisions() params not specified for Step 5 (GPT)
Guide says "call queryDecisions" but doesn't specify the exact params object.

**Fix**: Use `queryDecisions({ query: "architecture" }, projectRoot)` — a broad query that returns any active precedents. Already in the guide's Step 5 code example but should be more prominent.

---

## SHOULD FIX

### S1: Missing src/ directory edge case (GPT + Gemini)
If project has no `src/` directory, Step 2 will throw ENOENT. Many projects use `app/`, `lib/`, `server/`, etc.

**Fix**: Check if `src/` exists first. If not, try common alternatives (`app/`, `lib/`, `packages/`). If none found, skip scope generation with a helpful message.

### S2: Neither CLAUDE.md nor .cursorrules exists (GPT + Gemini)
Step 4 doesn't specify what happens if both files are missing. Should it create CLAUDE.md?

**Fix**: If neither exists, offer to create CLAUDE.md with the standing instructions as initial content. Show `confirm()` first.

### S3: Both CLAUDE.md and .cursorrules exist (GPT)
Guide implies "first match wins" but behavior is ambiguous.

**Fix**: Prefer CLAUDE.md. If both exist, inject into CLAUDE.md only (as the primary). Log a note that .cursorrules was found but CLAUDE.md was used.

### S4: Idempotency marker too weak — "context-ledger" string (GPT + Gemini)
Plain string "context-ledger" can false-positive on prose mentions of the package name.

**Fix**: Use the specific heading `## context-ledger Integration` as the marker for standing instructions. Use `"context-ledger post-commit hook"` as the marker for hooks (already more specific).

### S5: multiselect() with empty options array (GPT)
If no directories found, calling multiselect with `[]` options is broken UX.

**Fix**: Check if suggestions array is non-empty before calling multiselect. If empty, log info message and skip.

### S6: Sort directory suggestions for deterministic output (GPT)
readdir() order is not guaranteed across platforms.

**Fix**: Sort suggestions alphabetically before presenting in multiselect.

### S7: feature_hint_mappings generation underspecified (GPT + Gemini)
Guide mentions generating hints but doesn't specify the exact mapping strategy or merge behavior.

**Fix**: Generate simple keyword mappings from directory basenames. Merge additively — never overwrite existing user-curated hints.

### S8: Agent-guard block detection too vague (GPT)
"If agent-guard block exists, append after" — what identifies the block?

**Fix**: Search for `## agent-guard` or `# agent-guard` heading. If found, find the next heading of same or higher level, and insert before it. If no next heading, append to end.

### S9: Direct-run detection is brittle (GPT)
`process.argv[1]?.endsWith("setup.js")` breaks under npm shims and Windows.

**Fix**: Use `import.meta.url` comparison instead:
```typescript
import { fileURLToPath } from "node:url";
const isDirectRun = process.argv[1] === fileURLToPath(import.meta.url);
```

### S10: No .git directory handling (Gemini)
If user runs setup before `git init`, hook installation will fail cryptically.

**Fix**: Detect missing `.git/` and show helpful warning: "No git repository found. Run 'git init' and re-run setup to install hooks."

### S11: Existing config entries should not be overwritten (GPT + Gemini)
Generated scope_mappings should be additive, not replace existing manual entries.

**Fix**: After loadConfig, only add new keys. If a key already exists in scope_mappings, skip it and note "already configured".

---

## DESIGN QUESTIONS

### D1: What should Step 5 query exactly?
Consensus: Use `queryDecisions({ query: "architecture" }, projectRoot)` as a broad demonstration query. If pack is empty, show static example.

### D2: Should setup create CLAUDE.md if missing?
Consensus: Yes, offer to create it. Use `confirm()`.

### D3: Monorepo support — wizard scope
Both reviewers noted monorepo config fields are unused. This is intentional — v1 is single-repo. The wizard should not populate monorepo fields.

### D4: Where to inject if no agent-guard block exists?
If agent-guard is not present, append to end of file.

---

## SUGGESTED IMPROVEMENTS

### I1: Extract hook detection into shared module
Move detection logic into `src/capture/detect-hooks.ts` or similar. Return `{ system: "husky"|"lefthook"|"simple-git-hooks"|"bare"|"none", path?: string }`. Both cli.ts and setup.ts call this.

### I2: Use `import.meta.url` for direct-run detection
More reliable than `process.argv[1].endsWith()`.

### I3: Add `ensureConfigDir()` as first operation
Call `mkdir(ledgerDir(projectRoot), { recursive: true })` before any config operations.

### I4: Render DecisionPack as formatted summary, not raw JSON
Format active precedents as bullet list with ID, summary, and weight.

---

## Cross-Check Results

1. **Event types**: No new events — wizard is read/write config only. ✅
2. **MCP tools**: No MCP changes — wizard calls queryDecisions for demo only. ✅
3. **Lifecycle state machine**: Not affected. ✅
4. **Auto-promotion threshold**: Not affected. ✅
5. **Token budgeting**: Not affected (Step 5 demo is display-only). ✅
6. **Standing instructions snippet**: Must be exact text from spec lines 553-576. ✅ (specified in guide)
7. **Hook script template**: Must match cli.ts lines 401-405 exactly. ✅ (specified in guide)
8. **Config structure**: Must match LedgerConfig type and DEFAULT_CONFIG. ✅ (using loadConfig + merge)
