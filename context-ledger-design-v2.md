# context-ledger: Design Document v2.4.1

## What This Document Is

This is the design specification for `context-ledger`, an npm package for capturing and retrieving architectural decision history in AI-assisted development workflows. This is v2.4.1, revised after five rounds of adversarial review by GPT, Gemini, and Codex with human arbitration plus a v2.4.1 dogfood patch. v2 changes are noted with "v2 change". v2.1 changes from Round 2 review are noted with "v2.1". v2.2 changes from Round 3 review are noted with "v2.2". v2.3 changes from Round 4 review are noted with "v2.3". v2.4 changes from Round 5 review are noted with "v2.4". v2.4.1 changes from dogfood 2026-04-19 are noted with "v2.4.1".

**Target user:** Solo developer building with AI coding agents (Claude Code, Cursor, Windsurf). Team support is a future concern, not a v1 goal.

---

## Context: The Ecosystem This Tool Joins

context-ledger is the third tool in a composable developer tooling ecosystem. The other two are published and in production use.

### Tool 1: agent-guard (npm: @mossrussell/agent-guard)

A self-healing documentation system that keeps the *what* of a codebase accurate. Five layers:

1. **Standing Instructions** — lookup tables in AI agent config files (.cursorrules, CLAUDE.md) that map code directories to documentation targets. Also injects these instructions into agent config files during init and sync.
2. **Generated Inventories** — deterministic Node.js scripts that scan the codebase and produce markdown inventories of API routes, database models, and environment variables. Committed to git. Cannot lie.
3. **Pre-Commit Hook** — fires on every commit. Checks if doc-relevant code changed without corresponding doc updates. Can operate in advisory mode (exit 0 with warnings) or blocking mode (exit 1 to reject stale-doc commits).
4. **CI/CD Workflows** — GitHub Actions that regenerate inventories on push, diff against committed versions, create issues with remediation prompts.
5. **Session Context** — generates a rolling `.agent-guard/session-context.md` on every commit, summarizing recent changes, updated docs, and patterns to watch. This provides cross-session continuity so a new Claude Code instance knows what just happened.

**Key property:** Core pipeline is deterministic. Generated inventories and hook classification use zero LLM calls. The optional narrative doc auto-fix layer can call the Anthropic API on human commits to update prose documentation sections, but degrades gracefully to advisory mode when the API is unavailable or when an AI agent (not a human) triggers the commit.

**What it does NOT do:** It does not capture *why* things exist. It does not record architectural decisions, failed approaches, or design rationale.

**Integration opportunity (v2.2 update):** agent-guard and context-ledger have complementary but non-overlapping responsibilities:

- **agent-guard owns:** current factual state — generated inventories, documentation drift enforcement, standing instruction injection, and session recap (session-context.md).
- **context-ledger owns:** durable rationale — why decisions were made, rejected/abandoned approaches and their pain points, precedents that reduce Bucket 2 friction, and supersedence history.
- **Loading order contract:** When both are loaded by `/new-feature` or `/auto-feature`, agent-guard factual docs load first (inventories, session context), then context-ledger decision packs for scoped rationale. They must not write overlapping standing instructions without an explicit ordering contract that defines which tool's instructions take precedence on conflict.

context-ledger can also validate its own scope targets against agent-guard inventories to detect stale decisions pointing at files or routes that no longer exist.

### Tool 2: council-of-models-mcp (npm: council-of-models-mcp)

An MCP server that runs locally over stdio and exposes three tools to Claude Code:

- `ask_openai` — sends a prompt to OpenAI, returns the response
- `ask_gemini` — sends a prompt to Gemini with thinking enabled, returns the response
- `ask_all` — sends to both in parallel, returns both

**Key property:** Thin and generic. No knowledge of the project, codebase, or domain. All orchestration intelligence lives in Claude Code slash commands and the `/auto-feature` pipeline.

### The Agentic Development Workflow

```
/auto-feature "Add X to the dashboard"
│
├── Phase 1: EXPLORATION
│   ├── Code Inspector agent — traces types, construction sites, file dependencies
│   ├── Data Verifier agent — queries BigQuery via MCP, checks field existence and data quality
│   ├── Pattern Finder agent — traces end-to-end data flow patterns, flags inconsistencies
│   └── Synthesis → exploration-results.md
│
├── Phase 2: BUILD GUIDE
│   └── Produces agentic_implementation_guide.md (phased, validation-gated)
│
├── Phase 3: COUNCIL REVIEW
│   ├── OpenAI reviews engineering (type safety, field names, SQL, phase ordering)
│   ├── Gemini reviews business logic (calculations, data quality, export integrity)
│   └── Synthesis → council-feedback.md
│
├── Phase 4: SELF-TRIAGE + REFINEMENT
│   ├── Bucket 1: Apply autonomously (wrong field names, missing sites, bad SQL)
│   ├── Bucket 2: Needs human input (design choices, business rules, preferences)
│   ├── Bucket 3: Note but don't apply (scope expansions, deferred items)
│   └── Human answers Bucket 2 questions → guide updated → Refinement Log appended
│
└── Phase 5: EXECUTION (in a FRESH Claude Code instance)
    └── Agent executes the refined guide phase-by-phase with validation gates
```

**The gap:** Every Bucket 2 question requires human input every time, even if the same question was answered for a previous feature. Design decisions don't persist. The developer answers "use COALESCE with sensible defaults, don't filter NULLs" on Feature 1 and gets asked the same question on Feature 7. Institutional knowledge evaporates between features.

---

## What context-ledger Is

A decision capture and retrieval system for AI-assisted development. It records the *why* behind architectural and design choices, makes that reasoning retrievable via MCP, and integrates into the agentic development workflow so that accumulated decisions reduce the number of human input gates over time.

**agent-guard answers:** "What exists in the codebase?"
**context-ledger answers:** "Why does it exist that way? What was tried and abandoned? What constraints drove this choice?"

---

## The Problem It Solves

### Problem 1: Evaporating institutional knowledge

A solo developer working with AI agents makes dozens of architectural decisions per week. These decisions live in the developer's memory, old commit messages, chat histories, and Refinement Logs at the bottom of old implementation guides. None of these are queryable by an agent. When a new feature touches the same area, the agent makes the same wrong assumptions, proposes the same failed approaches, and surfaces the same design questions the developer already answered.

### Problem 2: Growing Bucket 2 friction

The `/auto-feature` pipeline's Phase 4 triage surfaces design questions as Bucket 2 (needs human input). As the codebase grows, the number of design questions per feature grows because more areas have established conventions the agent doesn't know about. Without decision history, the human gate gets heavier over time instead of lighter.

### Problem 3: AI agents repeating abandoned approaches

The developer tried approach A, it failed for specific reasons, they switched to approach B. Nothing records why approach A was abandoned. Three months later, a new agent session proposes approach A again.

### Problem 4: Context file bloat

The common workaround is stuffing everything into ARCHITECTURE.md. This file grows to 1000+ lines. The AI agent loads the entire file every session but only needs the 30 lines relevant to the current task. Token waste, context pressure, and attention dilution.

---

## How It Works

### Data Model

**v2 change:** The original design used a single mutable record with a `status` field and a `confidence` string. Both reviewers flagged this as internally contradictory (append-only storage + mutable status) and dangerously vague (unverified data labeled "high confidence"). The v2 design uses an event-sourced model with separate trust tracking.

The ledger is an append-only event log. Two event types:

#### Decision Records

```jsonc
{
  "type": "decision",
  "id": "d_1711900800_a3f2",
  "created": "2026-03-31T18:00:00Z",
  "source": "manual",                     // "manual", "workflow-writeback", "commit-inferred", "backfill"
  "evidence_type": "human_answered",       // see Evidence Types below
  "verification_status": "confirmed",      // "unreviewed", "confirmed", "corrected", "rejected"
  "commit_sha": "abc1234",                 // null for manual captures
  
  // What was decided
  "summary": "Use @google/genai SDK for Gemini provider integration",
  "decision": "Use @google/genai SDK instead of raw REST calls",
  "alternatives_considered": [
    {
      "approach": "Raw fetch() to Gemini REST API",
      "why_rejected": "SDK handles auth, retries, and thinking config natively. Maintenance burden lower.",
      "failure_conditions": null
    }
  ],
  "rationale": "SDK provides type-safe ThinkingLevel enum and handles dual API key resolution.",
  "revisit_conditions": "If the SDK drops thinking config support or adds unacceptable bundle size",
  "review_after": null,                    // ISO date, required for durability="temporary-workaround"
  
  // Where it applies (scoped, not raw paths)
  "scope": {
    "type": "concern",                     // "package", "directory", "domain", "concern", "integration"
    "id": "gemini-provider"
  },
  "affected_files": ["src/providers/gemini.ts", "package.json"],
  "scope_aliases": [],                     // prior paths if files were renamed
  "decision_kind": "dependency-choice",    // freeform label, not enumerated — see Decision Kinds below
  
  // Classification
  "tags": ["dependency", "gemini", "sdk"],
  "durability": "precedent"                // "precedent", "feature-local", "temporary-workaround"
}
```

#### Transition Events

To change a decision's lifecycle status, append a transition event. Never mutate existing records.

```jsonc
{
  "type": "transition",
  "id": "t_1711987200_b4e1",
  "created": "2026-04-01T18:00:00Z",
  "target_id": "d_1711900800_a3f2",        // the decision being transitioned
  "action": "supersede",                   // "supersede", "abandon", "expire", "reopen", "reinforce"
  "replaced_by": "d_1711987200_c5f2",      // new decision ID, if superseding
  "reason": "Switched to raw REST because SDK v2 dropped thinking config",
  "pain_points": [                         // what went wrong with the old approach
    "SDK v2 removed ThinkingLevel enum without deprecation notice",
    "Bundle size increased 40% with no opt-out"
  ]
}
```

**v2 change: `pain_points` on transitions.** When a decision gets superseded, explicitly capturing what went wrong with the old approach is the highest-signal data for preventing repeated mistakes. This was a GPT recommendation and it's correct.

**v2.2 addition: `reinforce` transition event.** When a new Phase 4 answer reaffirms an existing precedent, a `reinforce` transition is appended instead of creating a duplicate record:

```jsonc
{
  "type": "transition",
  "id": "t_1712016000_r1a2",
  "created": "2026-04-02T02:00:00Z",
  "target_id": "d_existing_record",
  "action": "reinforce",
  "reason": "Reaffirmed during SQO drill-down feature Phase 4 triage",
  "source_feature_id": "auto-feature-2026-04-01"
}
```

**v2.3 clarification: `reinforce` ranking semantics.** `reinforce` does NOT change a record's base `retrieval_weight`, `evidence_type`, trust level, or lifecycle state (the target remains `active`). It contributes a bounded ranking bonus during retrieval only:

```
effective_rank_score = base_retrieval_weight + min(0.15, 0.05 * reinforcement_count)
```

Where `reinforcement_count` is the number of valid `reinforce` events on the record. Each reinforcement adds +0.05 to the ranking score, capped at +0.15 total bonus. The effective score can never exceed 1.0. This bonus is used solely for ranking among otherwise relevant active precedents — it must never make an untrusted (`retrieval_weight < 0.7`), superseded, abandoned, or expired record eligible for auto-promotion. Repeated reinforcement cannot override supersedence, abandonment, expiry, or durability rules.

#### Evidence Types

Replaces the vague `confidence` field from v1:

| Evidence Type | Meaning | Retrieval Weight |
|---|---|---|
| `human_answered` | Developer answered a direct question | 1.0 |
| `explicit_manual` | Developer used `/decision` to capture proactively | 1.0 |
| `workflow_writeback` | Captured from Phase 4 Bucket 2 answer (human-verified) | 0.9 |
| `confirmed_draft` | Hook-inferred draft that developer confirmed | 0.8 |
| `corrected_draft` | Hook-inferred draft that developer corrected | 0.85 |
| `backfill_confirmed` | Historical commit the developer confirmed in backfill | 0.7 |
| `commit_inferred` | Hook-inferred, not yet reviewed | 0.2 |

**Critical rule:** Only records with retrieval weight >= 0.7 can be used for auto-promotion from Bucket 2 to Bucket 1 in the `/auto-feature` triage. Unreviewed inferred records (0.2) are retrievable for context but never treated as trusted precedent.

#### Decision Kinds (Freeform, Not Enumerated)

**v2.1 change:** The original v2 specified 12 rigid `decision_kind` categories. Gemini correctly flagged that an LLM will struggle to consistently categorize decisions into fixed buckets ("Is Zod validation a `data-shape` or `api-contract` decision?"), producing duplicates and inconsistent retrieval. 

`decision_kind` is now a freeform string, not an enum. The agent assigns a short descriptive label when creating the record (e.g., "null-handling", "gemini-sdk-choice", "csv-export-format"). These are used as soft signals for retrieval grouping, not hard categories for conflict detection. The agent detects conflicts by analyzing the `decision` text of active records within the same scope, not by rigid kind matching.

Conflict detection operates within `scope`. The agent analyzes the `decision` text of active records within the same scope to detect semantic conflicts rather than relying on rigid categorical matching.

**Recommended vocabulary for recurring decision types (v2.2 addition):**

While `decision_kind` is freeform, the following labels are recommended for common recurring decision classes in dashboard/query/export workflows. Using consistent labels improves retrieval grouping across features:

- `null-handling` — COALESCE defaults, filtering vs keeping sparse rows
- `date-handling` — extractDate vs extractDateValue, timezone conventions
- `export-format` — CSV escaping, column mapping, Sheets export edge cases
- `type-construction` — how typed objects are built from raw BigQuery rows
- `api-passthrough` — which API routes transform data vs pass through
- `query-pattern` — SELECT conventions, parameterized queries, import merges
- `dependency-choice` — why a specific library/SDK was chosen
- `module-boundary` — why code is organized into specific directories/services

These are suggestions, not constraints. The agent should use whichever label best fits. But reusing these labels when applicable prevents retrieval splintering across synonyms like "null-handling" vs "nullable-field-defaults" vs "coalesce-policy".

#### Decision Lifecycle State Machine

**v2.1 addition.** Both reviewers flagged incomplete transition semantics. These are the legal state transitions, enforced during event fold and by MCP write tools:

```
                ┌─────────────┐
                │   active     │
                └──┬───┬───┬──┘
                   │   │   │
          supersede│   │   │abandon
                   │   │   │
                   ▼   │   ▼
            ┌──────┐   │  ┌──────────┐
            │super- │   │  │abandoned │
            │seded  │   │  └────┬─────┘
            └──┬────┘   │       │
               │        │expire │reopen
               │        │       │
               │        ▼       │
               │   ┌─────────┐  │
               │   │expired  ├──┘
               │   └────┬────┘
               │        │reopen
               │        │
               │        ▼
               │   ┌─────────┐
               └──►│(active) │ (only via reopen from abandoned/expired)
                   └─────────┘
```

**Invariants:**
- Each decision has exactly one current state, derived by folding transitions in chronological order
- `supersede` requires `replaced_by` to reference an existing decision ID. The replacement must be appended before the transition.
- `superseded` is terminal. Cannot be reopened. The replacement decision is the canonical successor.
- `abandoned` and `expired` can be reopened (returns to `active`). Use case: a workaround becomes permanent, or a rejected approach becomes viable due to ecosystem changes.
- No cycles: if A supersedes B, B cannot later supersede A. Enforced by checking the supersedence chain during `supersede_decision` writes.
- `reinforce` is valid only on `active` decisions. It does not change state — it is an annotation event that records reaffirmation. Multiple `reinforce` events on the same target are valid and expected.
- Multiple transitions on the same target are valid only if they follow the legal paths above. Duplicate identical transitions are idempotent no-ops.
- `validate` checks all invariants and reports violations. Does not auto-repair state machine errors.

#### Durability Classification

**v2 addition.** Not every decision deserves permanent institutional weight.

| Durability | Meaning | Auto-promotion eligible? |
|---|---|---|
| `precedent` | Project-wide convention that should persist | Yes |
| `feature-local` | Applies to this feature only | No |
| `temporary-workaround` | Active until underlying issue is resolved | No, and must have `review_after` date |

**v2.1 additions:**

**`review_after` for temporary workarounds.** GPT flagged that freeform `revisit_conditions` are useful for humans but machines cannot act on them. Temporary workarounds now require a `review_after` ISO date in addition to freeform conditions. When the date passes, the MCP server flags the workaround in decision packs as `review_overdue: true`. The agent surfaces it proactively.

**Feature-local auto-demotion.** Feature-local records are excluded from `query_decisions` results by default. They are only returned when the caller explicitly passes `include_feature_local: true` or queries by the exact file path of a feature-local record. Feature-local records auto-expire 60 days after creation unless the developer promotes them to `precedent`. This prevents retrieval pollution from one-off decisions.

### Storage

**v1: Local JSONL event log.** `.context-ledger/ledger.jsonl` in the project root. Strictly append-only. Git-trackable. Zero infrastructure.

The MCP server computes current state by folding the event log at startup: reading all decision records and applying all transition events to derive the active/superseded/abandoned status of each decision.

Supporting files:
```
.context-ledger/
├── ledger.jsonl          # append-only event log (decisions + transitions)
├── inbox.jsonl           # structured pending queue (drafts + questions)
├── config.json           # classification rules, ignored paths, scope mappings, redaction patterns
└── .gitkeep
```

**v2 change:** `pending.md` replaced with `inbox.jsonl`. Both reviewers flagged markdown as the wrong data structure for workflow state. The structured inbox supports TTL, priority, staleness tracking, and deduplication.

**Why JSONL:**
- Zero dependencies (Node built-ins only, matching agent-guard)
- Git-trackable (decision history appears in PRs and diffs)
- Works offline
- Append-only event log handles the lifecycle problem cleanly. For a solo developer on short-lived branches, concurrent appends are usually auto-mergeable by git. Long-lived branches or rebases may produce conflicts; resolve by replaying appended events in chronological order.
- Readable with `cat` and `grep` for debugging
- At solo-dev scale (50-500 records/year), raw scan is sub-millisecond

### Capture: Two Tiers

**v2 change:** Tier 1 (fully automated write to trusted ledger) has been eliminated. Both reviewers identified this as a critical flaw — inferring *why* from a diff produces fabricated intent that poisons the ground truth. Everything now flows through human verification, but at different friction levels.

The post-commit hook is instantaneous and dumb. It contains zero LLM calls. It reads the committed diff metadata, classifies it using deterministic heuristics, and appends a structured entry to `inbox.jsonl`. Processing happens asynchronously in the next Claude Code session.

**v2 change:** The hook no longer generates drafts, rationale, or summaries. It records *what changed* (files, directories, dependencies) and *what category* of change it was. The LLM generates the draft in the next session when it processes the inbox. This keeps the hook under 100ms.

#### Tier 1: Draft + Confirm (target: ~70% of structural changes)

The hook detected a structural change that likely represents a decision worth capturing.

**Triggers:**
- New dependency added/removed in `package.json`
- New environment variable in `.env.example`
- New directory created with multiple files
- Files deleted or directories removed
- Config file changes (tsconfig, eslint, CI workflows)
- New API route or page route added
- Database schema changes

**What happens at commit time:** The hook classifies the diff and writes one or more queue entries to `inbox.jsonl`. **v2.1 change:** If a commit contains multiple unrelated structural changes (e.g., a dependency addition AND a new route), the hook emits separate inbox items per detected change cluster, grouped by file proximity and change type. This prevents draft generation from conflating unrelated decisions.

```jsonc
{
  "inbox_id": "q_1711900800_a1",
  "type": "draft_needed",
  "created": "2026-03-31T18:00:00Z",
  "commit_sha": "abc1234",
  "commit_message": "Add Gemini provider with @google/genai SDK",
  "change_category": "dependency-addition",
  "changed_files": ["package.json", "src/providers/gemini.ts"],
  "diff_summary": "+@google/genai: ^1.46.0",
  "priority": "normal",
  "expires_after": "2026-04-14T18:00:00Z",      // 14-day TTL
  "times_shown": 0,
  "last_prompted_at": null,
  "status": "pending"                             // "pending", "confirmed", "corrected", "dismissed", "expired", "ignored"
}
```

**What happens next session:** Standing instructions tell the agent to check `inbox.jsonl` for pending items. The agent reads the queue entry, generates a draft decision record based on the diff metadata and current codebase context, and presents it:

"Your last commit added `@google/genai` as a dependency and created `src/providers/gemini.ts`. Draft: You chose the Google GenAI SDK for Gemini integration instead of raw REST calls. Accurate, or want to adjust?"

Developer confirms → agent writes a `decision` event to `ledger.jsonl` with `evidence_type: "confirmed_draft"`, `verification_status: "confirmed"`.

Developer corrects → agent writes with `evidence_type: "corrected_draft"`, `verification_status: "corrected"`, incorporating the correction. **v2.1 addition:** The record also stores correction metadata: `draft_inference_summary` (what the agent originally inferred), `correction_reason` (what was wrong), and `corrected_fields` (which fields changed). This feedback signal identifies bad trigger patterns and improves future draft quality.

Developer dismisses → inbox entry marked `status: "dismissed"`, with optional `rejection_reason`. No ledger write. No further prompts.

#### Tier 2: Must Ask (target: ~30% of structural changes)

The hook detected a change that represents a significant architectural decision where even generating a draft would require speculation.

**Triggers:**
- Major module replacement (swapping one library/framework for another)
- Changes that contradict an existing active decision in the ledger
- Authentication or security pattern changes
- Database migration or provider switch
- Removal of a feature or capability

**What happens at commit time:** Same as Tier 1 — a queue entry in `inbox.jsonl` with `type: "question_needed"` instead of `type: "draft_needed"`.

**What happens next session:** The agent reads the queue entry, reviews the diff, and asks a targeted question. Not open-ended. Specific, based on what the diff shows:

"You replaced the middleware pattern with route-level handlers and deleted `src/middleware/`. What drove this change? What didn't work about the middleware approach?"

Developer answers → agent writes a `decision` event with `evidence_type: "human_answered"`, `verification_status: "confirmed"`. If an existing active decision was contradicted, the agent also writes a `transition` event to supersede it.

#### Inbox Hygiene

**v2 addition.** Both reviewers flagged the original `pending.md` as a guaranteed graveyard.

**v2.1 clarification:** Inbox items have four distinct terminal states, not a collapsed "abandoned":

| Terminal State | Meaning | Signal Value |
|---|---|---|
| `confirmed` | Developer confirmed the draft → decision written to ledger | Classifier worked correctly |
| `corrected` | Developer corrected the draft → corrected decision written | Classifier was close but wrong on details |
| `dismissed` | Developer explicitly said "no, don't capture this" | Classifier produced a false positive |
| `expired` | TTL elapsed without any interaction | Change wasn't important enough to address |
| `ignored` | Shown 3 times, developer skipped each time | Friction too high or timing wrong |

This distinction preserves signal about classifier quality. A high `dismissed` rate for a trigger pattern means the classification heuristic needs tuning. A high `ignored` rate means the prompting cadence is wrong.

Rules:
- Each inbox entry has a 14-day TTL (`expires_after`). After expiration, status becomes `expired`.
- Entries are shown a maximum of 3 times (`times_shown`). After 3 skips without explicit confirmation or dismissal, status becomes `ignored`.
- The agent presents a maximum of 3 inbox items per session start. Priority ordering: Tier 2 (must-ask) before Tier 1 (drafts). Recency as tiebreaker.
- Expired and ignored entries remain in `inbox.jsonl` for auditability but are never shown again.
- `context-ledger tidy` CLI command compacts `inbox.jsonl` by removing terminal entries older than 30 days.

**v2.1 addition: Inbox check is embedded in `/auto-feature`, not just standing instructions.** Gemini correctly flagged that agents will skip standing instruction inbox checks when the developer opens with an immediate task. The `/auto-feature` pipeline now includes an inbox check as an unskippable step before Phase 1 exploration begins. If actionable inbox items exist, they're presented before exploration agents spawn. This ensures decisions from recent commits inform the current feature's exploration.

### Capture: Workflow Write-Back (Selective)

**v2 change:** Write-back from Phase 4 is no longer automatic for all answers. Each answer is classified before capture.

When the `/auto-feature` pipeline reaches Phase 4 and the developer answers Bucket 2 design questions, the agent classifies each answer:

| Classification | Example | Action |
|---|---|---|
| `precedent` | "Always use COALESCE with sensible defaults for nullable fields" | Write to `ledger.jsonl` as `durability: "precedent"` |
| `feature-local` | "Sort this specific table by date descending" | Write with `durability: "feature-local"` |
| `temporary-workaround` | "Use string concatenation here until the SDK supports template queries" | Write with `durability: "temporary-workaround"` and require `revisit_conditions` |

Only `precedent` records are eligible for auto-promotion in future Phase 4 triage. Feature-local and temporary records are retrievable as context but don't drive autonomous behavior.

All workflow write-back records get `evidence_type: "workflow_writeback"`, `verification_status: "confirmed"` (human-verified by definition).

**Write-back deduplication (v2.2 addition):** Repeated Phase 4 answers about the same convention should reinforce existing precedent, not clone it. Before writing a new precedent record, the agent checks for an existing active precedent in the same scope with high semantic overlap. If found:

- If the new answer is substantively identical to the existing precedent, attach a reinforcing annotation event to the existing record (new event type: `reinforce`, with timestamp and `source_feature_id`). This contributes a bounded ranking bonus: `effective_rank_score = base_retrieval_weight + min(0.15, 0.05 * reinforcement_count)`, capped at 1.0. This means a highly reaffirmed `confirmed_draft` (base 0.8 + 0.15 bonus = 0.95) can rank alongside direct manual captures (1.0) after sustained reaffirmation, but never exceed them. No duplicates are created.
- If the new answer materially extends or revises the existing precedent, create a new record and supersede the old one with a transition event.
- If the new answer contradicts the existing precedent, surface it to the developer as a conflict requiring explicit resolution before writing.

This prevents five features from producing five near-identical "use COALESCE with sensible defaults" records.

### Capture: Manual (/decision command)

A Claude Code slash command for explicit mid-session capture:

```
/decision "switching from Supabase to Neon for Postgres"
```

The agent asks 2-3 targeted questions:
1. What drove this change?
2. What did you try first? (if switching away from something)
3. What would make you revisit this decision?

Writes to `ledger.jsonl` with `source: "manual"`, `evidence_type: "explicit_manual"`, `verification_status: "confirmed"`.

### Capture: Backfill (JIT, Not Batch)

**v2 change:** The original design proposed a batch `/backfill` command that interviews the developer on 90 days of commits. GPT correctly identified that developers will abandon this interview halfway through, producing low-quality retrospective rationalization. The v2 approach is just-in-time.

**How JIT backfill works:** When `/auto-feature` or `/new-feature` runs Phase 1 exploration and queries `query_decisions` for relevant context, the MCP server may return a `no_precedent_found` signal for a scope/area that clearly has established patterns in the code. The agent then checks the git log for structural commits affecting those files and surfaces the most relevant ones:

"I found no decision history for `src/lib/queries/`, but there are 3 structural commits in the last 6 months affecting query patterns. Want to capture the reasoning behind any of them?"

This captures decisions at the moment they're relevant, not as a homework assignment. One or two targeted captures when you need them, not 14 in a batch you'll never finish.

A `/backfill` CLI command still exists for developers who want to bootstrap, but it's positioned as optional, not the primary cold-start strategy. It processes a maximum of 5 commits per session by default.

### Retrieval: MCP Server

A lightweight MCP server exposed as `npx context-ledger serve` (or a global `context-ledger-mcp` binary). Runs over stdio.

**v2 change: Retrieval strategy.** Both reviewers agreed that keyword tokenization would fail on the exact queries that matter. A query for "why don't we filter NULLs" would miss a record about "COALESCE with sensible defaults" because the terms are semantically related but lexically divergent.

**v2.1 change: File-path-first retrieval with server-side scope derivation.** Both Round 2 reviewers flagged that v2's retrieval was under-specified — it punted semantic matching to the agent without defining what the server actually does. The v2.1 approach makes the server responsible for scope resolution and the agent responsible for semantic reasoning.

**The retrieval contract:**

1. The caller provides a `file_path`, a natural language `query`, or both.
2. If `file_path` is provided, the server derives scope by consulting `scope_mappings` in config, then `scope_aliases` in existing records, then falling back to the top-level directory name as scope ID. This is the primary retrieval path for agent workflows.
3. **v2.3 change: Deterministic fallback order for query-only calls.** When no `file_path` or explicit scope params are provided, the server resolves scope candidates in this exact order:
   1. Explicit `scope_type` + `scope_id` params (if provided — highest priority)
   2. `file_path`-derived scope via `scope_mappings` → `scope_aliases` → directory fallback (if `file_path` provided)
   3. `feature_hint_mappings` phrase matches against the `query` string (deterministic, configurable — see Configuration section). The server tokenizes the query, matches tokens against `feature_hint_mappings` keys, and unions the mapped scope candidates. For example, a query mentioning "drill-down export" would match `"drill-down" → ["query-layer"]` and `"export" → ["export-format"]`, returning precedents from both scopes.
   4. Pure recency fallback: N most recently active precedents — last resort only, used when no other derivation is possible.
   
   The agent scans the returned list with full LLM reasoning. This prevents "no precedent found" false negatives caused by wrong parameter guessing.
4. The server performs structural filtering (scope, tags, durability, verification status, retrieval weight threshold) and returns a bounded decision pack.
5. The agent (Claude Code) performs semantic matching over the pack contents. The LLM is already in the loop. Let it do what it's good at.

This keeps the MCP server zero-dependency and avoids building a bad search engine in Node.js, while ensuring the server does enough work that the agent doesn't have to guess the right taxonomy.

**Read tools:**

`query_decisions` — Primary retrieval tool.

Parameters:
- `file_path` (string, optional) — primary entry point. Server derives scope automatically.
- `query` (string, optional) — natural language query. If no file_path or scope provided, triggers broad fallback.
- `scope_type` (string, optional) — explicit scope filter (overrides file_path derivation)
- `scope_id` (string, optional) — explicit scope identifier
- `decision_kind` (string, optional) — soft filter by kind label
- `tags` (string[], optional) — filter by tags
- `include_superseded` (boolean, optional, default false)
- `include_unreviewed` (boolean, optional, default false)
- `include_feature_local` (boolean, optional, default false) — **v2.4:** opt in to `feature-local` durability records across every section of the decision pack. Bypasses the default file-path-match requirement globally.
- `limit` (number, optional, default 20)
- `offset` (number, optional, default 0) — for paginating when previous query returned `truncated: true`. Allows agent to retrieve records beyond the token budget cutoff.

`search_decisions` — CLI/debugging tool with basic lexical fallback and diagnostics. Not intended for agent workflows.

Returns a decision pack with per-item match explanations and token budgeting:

```jsonc
{
  "derived_scope": {                     // what the server inferred from file_path
    "type": "domain",
    "id": "query-layer",
    "source": "config_mapping"           // or "scope_alias", "directory_fallback"
  },
  "active_precedents": [
    {
      "record": { ... },
      "match_reason": "scope_hit",       // "scope_hit", "file_path_hit", "tag_match", "broad_fallback"
      "retrieval_weight": 0.85
    }
  ],
  "abandoned_approaches": [...],         // with pain_points, same match_reason format
  "recently_superseded": [...],          // superseded in last 90 days
  "pending_inbox_items": [...],          // unresolved inbox entries for this scope
  "mistakes_in_scope": [...],            // v2.4: antipatterns surfaced FIRST under token pressure
  "no_precedent_scopes": [...],          // queried scopes with zero trusted matches
  "token_estimate": 1847,               // approximate token count of the full pack
  "truncated": false                     // true if pack exceeded budget and was trimmed
}
```

**Token budgeting (v2.1 addition, v2.4 revision):** Decision packs must not recreate the context bloat problem they exist to solve. The server enforces a configurable token budget (default: 4000 tokens per pack). If the filtered result set exceeds the budget, records are trimmed in this priority order (first to drop → last to drop): `active_precedents` (popped from the tail, lowest effective_rank_score first) → `recently_superseded` (dropped entirely) → `abandoned_approaches` (dropped entirely) → `pending_inbox_items` (capped at `inbox_max_items_per_session`, then popped from tail) → `mistakes_in_scope` (last casualty, popped from tail). The `truncated` flag is set once on entering the trim block and never reset. See the **mistakes_in_scope (v2.4 addition)** subsection below for the rationale.

### mistakes_in_scope (v2.4 addition)

**What it is.** A dedicated array of antipatterns surfaced before active precedents so token-truncated packs retain the highest-signal-per-token data: what *not* to do. Active precedents describe current-state rationale; mistakes describe known failure modes that must not be repeated. Under token pressure, "don't do X because it broke prod" is cheaper and more actionable than a full statement of current convention.

**Three entry kinds** (discriminated union on `kind`):

1. **`superseded_with_pain_points`** — a decision in the `superseded` state whose supersede transition carried a non-empty `pain_points` array. Fields: `record`, `match_reason`, `pain_points[]`, `replaced_by`.
2. **`abandoned`** — a decision in the `abandoned` state. Fields: `record`, `match_reason`, `reason` (from the abandon transition), `pain_points[]` (may be empty).
3. **`rejected_inbox_item`** — a dismissed inbox item with a non-empty `rejection_reason`. Fields: `inbox_id`, `commit_sha`, `commit_message`, `changed_files[]`, `rejection_reason`, `rejected_at`.

Sort order: by kind (1 → 2 → 3), then by recency descending within each kind.

**Sources — retrieval-contract extension only.** `mistakes_in_scope` is populated entirely from the existing fold output plus dismissed inbox items. It introduces no new event types, no new transitions, and no new JSONL shape. `DecisionRecord` and `TransitionEvent` schemas are **untouched**; the fold-logic audit confirms zero event-schema change. This is a retrieval-layer addition.

**Exclusions:**
- `commit_inferred` records (retrieval weight 0.2) are excluded from `mistakes_in_scope` even in `abandoned` or `superseded` state. Unreviewed inferences never drive agent behavior — including as antipatterns. They remain in `abandoned_approaches` / `recently_superseded` as informational context only. This asymmetric treatment is intentional.
- `feature-local` durability records are excluded by default. Pass `include_feature_local: true` to opt in. The flag is a global short-circuit — it bypasses the existing feature-local file-path-match requirement for **every** section of the decision pack, not only `mistakes_in_scope`.

**Deduplication.** Records promoted into `mistakes_in_scope` are removed from `abandoned_approaches` and `recently_superseded`. This prevents token-budget double-counting that would trigger premature trimming of the bucket we most want to preserve.

**Trim priority (user-locked, spec-literal).** Under token pressure, the trim sequence is: `active_precedents` (pop from tail) → `recently_superseded` (drop) → `abandoned_approaches` (drop) → `pending_inbox_items` (cap, then pop) → `mistakes_in_scope` (pop from tail). A heavily truncated pack can legitimately return `active_precedents.length === 0` alongside a full `mistakes_in_scope`. That is the intentional "antipatterns > active precedents under token pressure" bet: the agent can re-query with offset paging to retrieve trimmed active precedents, but cannot recover antipatterns that were never surfaced in the first place.

**Scope rules.** Same derivation paths as `active_precedents`:
1. Explicit `scope_type` + `scope_id`.
2. `file_path` → `scope_mappings` (longest-prefix match) → `scope_aliases` on active decisions → directory fallback (segment after `src/`).
3. `feature_hint_mappings` phrase match against `query`.
4. Recency fallback (`derivedScope === null`).

For rejected inbox items: `changed_files` must intersect the derived scope via the same order (scope_mappings → scope_aliases → directory fallback). Empty `changed_files` falls back to substring match of `scope.id` against `commit_message`.

**Recency fallback behavior.** When `derivedScope === null`, `mistakes_in_scope` includes the **N=10** most recent dismissed inbox items with `rejection_reason`, sorted by `rejected_at` descending. Decisions in `abandoned`/`superseded` state are surfaced via the existing `broad_fallback` match path and classified into `mistakes_in_scope` exactly as in the scoped case (subject to `commit_inferred` exclusion).

**CLI render.** `context-ledger query <text>` now calls `queryDecisions` (replacing `searchDecisions`) and renders the full decision pack. The "Prior mistakes in this scope" section is emitted first, before active precedents. This makes the CLI a faithful debugging mirror of what the agent sees over MCP.

**Tidy interaction.** Rejected-inbox mistakes are subject to the existing 30-day `tidyInbox` TTL. Dismissed items older than 30 days are removed by `context-ledger tidy` and can no longer surface in `mistakes_in_scope`.

**Scope mapping fallback (v2.1 addition):** Gemini flagged that developers will map 4 directories on day one and never update `scope_mappings` again. If a file path doesn't match any explicit mapping, the server falls back to the top-level directory name as scope ID (e.g., `src/app/billing/handler.ts` → scope `{ type: "directory", id: "billing" }`). Explicit mappings override the fallback but are not required.

**Write tools (v2 addition):**

Both reviewers agreed the MCP server needs write support, but Gemini correctly specified that writes should be narrow and structured, not arbitrary freeform inserts. **v2.1 addition:** All write tools require a `client_operation_id` for idempotency. Duplicate operations (same ID) are no-ops, not errors.

- `propose_decision(client_operation_id, ...)` — agent drafts a decision record, writes to `inbox.jsonl` for developer confirmation next session
- `confirm_pending(inbox_id, client_operation_id, ...)` — confirm an inbox item, write the decision to `ledger.jsonl`. Rejects if inbox item is already resolved.
- `reject_pending(inbox_id, client_operation_id, reason?)` — dismiss an inbox item. Stores rejection reason if provided.
- `supersede_decision(target_id, replaced_by, client_operation_id, reason, pain_points?)` — write a transition event. Validates against lifecycle state machine (target must be active, replacement must exist, no cycles).
- `record_writeback(client_operation_id, source_feature_id, ...)` — write a workflow write-back decision. Requires `durability` classification. Deduplicates against existing records in same scope with similar decision text. **v2.3 addition: reinforce-first preference.** Before creating a new precedent record, `record_writeback` should query for existing active precedents in the same scope with high semantic overlap. If the answer reaffirms an existing precedent, the tool should emit a `reinforce` transition instead of a new decision record. If the answer materially revises the precedent, it must create a new decision and supersede the old one. If the answer contradicts the existing precedent, it must surface the conflict to the developer before writing. Since MCP servers cannot directly prompt the user, the tool returns a structured response: `{status: 'conflict_detected', existing_precedent: {...}, proposed_decision: {...}, message: '...'}`. The calling agent reads this payload and pauses to present the conflict to the developer before proceeding.

### Retrieval: Standing Instructions Integration

Addition to the project's AI agent config:

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

## Integration with the Agentic Workflow

### /new-feature and /auto-feature — Phase 1 Enhancement

**Current behavior:** Three agents explore the codebase in parallel. They see what exists but not why.

**With context-ledger (v2.3: executable integration contract):** Affected files are not known until the exploration team runs, so integration follows a five-step sequence. This contract applies to BOTH `/new-feature` and `/auto-feature`.

**Step 0 — Inbox Check:** Check `.context-ledger/inbox.jsonl` for pending items before exploration begins. Present up to 3 items (Tier 2 must-ask first, then Tier 1 drafts). Resolve before proceeding. This runs for both `/new-feature` and `/auto-feature`, not just `/auto-feature`.

**Step 1 — Pass A Retrieval:** Query context-ledger with the feature description and any user-mentioned files, areas, or dashboard surfaces. Use `feature_hint_mappings` for scope derivation if no explicit file paths are known yet. Returns broad precedents about null handling, date conventions, export patterns, and abandoned approaches. JIT backfill triggers here if `no_precedent_scopes` returns scopes that clearly have established code patterns.

**Step 2 — Spawn Teammates with Targeted Subsets:** Inject Pass A results into each teammate's task prompt. Each teammate gets a targeted subset of the decision pack:

- **Code Inspector** receives precedents about type additions, construction sites, route transformation patterns, and export mapping conventions.
- **Data Verifier** receives precedents about nullable fields, field trustworthiness, CSV escaping edge cases, and abandoned BigQuery/view approaches.
- **Pattern Finder** receives precedents about null/date/type coercion conventions and explicitly abandoned patterns.

All three teammates also receive shared abandoned-approach records when relevant to their investigation area.

**Step 3 — Pass B Retrieval:** After Code Inspector and Pattern Finder return their findings with concrete file paths, re-query context-ledger by those specific file paths. This catches file-path-derived precedents that the broad Pass A query missed. JIT backfill also triggers here if new `no_precedent_scopes` are discovered.

**Step 4 — Synthesis:** Merge Pass A broad precedents and Pass B file-specific precedents into `exploration-results.md`. Pass B augments Pass A; it does not discard earlier broad precedents unless they are superseded by more specific Pass B results. The synthesis report includes two new sections: **Prior Decisions** listing all relevant ledger entries from both passes, and **Decision Gaps** listing scopes with no precedent (flagged for Bucket 2 in Phase 4).

### /auto-feature — Phase 2 Enhancement (Build Guide)

**Current behavior:** The build guide agent makes choices about patterns, approaches, and conventions based on what it observes in code.

**With context-ledger:** At choice points, the agent checks the decision pack. If a trusted precedent exists (retrieval_weight >= 0.7), it follows the precedent and cites the decision ID. If an abandoned approach exists, it explicitly avoids that approach and notes why. If no precedent exists and the choice is ambiguous, it flags it as a Bucket 2 question for Phase 4 instead of silently picking.

### /auto-feature — Phase 3 Enhancement (Council Review)

**Current behavior:** Council reviewers sometimes flag intentional design choices as bugs because they don't know the history.

**With context-ledger:** Relevant trusted precedents are included in the council review payload. The prompt includes: "The following design decisions are established precedent with verified human approval. Do not flag these as issues unless you believe the precedent itself is flawed — and if so, explain specifically what has changed to invalidate it."

This reduces false positives and focuses reviewer attention on genuinely novel problems. Council review should NOT include unreviewed inferred records.

### /auto-feature — Phase 4 Enhancement (Self-Triage)

**Current behavior:** Bucket 2 questions require human input every time.

**With context-ledger:** During triage, Claude checks each Bucket 2 question against the decision pack. Auto-promotion from Bucket 2 to Bucket 1 requires ALL of the following (v2.1 — full predicate):

1. A matching decision exists with `retrieval_weight >= 0.7`
2. The decision has `durability: "precedent"`
3. The decision's current derived state is `active` (not superseded, abandoned, or expired)
4. The decision's scope overlaps with the question's affected area (file path match, scope match, or derived scope match)
5. The agent can articulate why the precedent applies to this specific question (not just "similar topic")

If any condition fails, the question stays in Bucket 2 for human input. The auto-promoted action cites the decision ID in the Refinement Log and includes the match explanation so the developer can audit what happened.

After the developer answers remaining Bucket 2 questions, the agent classifies each answer by durability and uses `record_writeback` for precedent-worthy answers only.

### /auto-refactor

Post-refactor commits trigger the same capture pipeline. If the refactor changes an established convention, the agent queries for active decisions in the affected scope, presents them, and prompts the developer to supersede with the new approach — capturing `pain_points` from the old approach.

---

## Decision Lifecycle Management

Decisions have a lifecycle managed entirely through transition events. The current state of any decision is computed by folding the event log.

**active** → No transition events. The decision is current.

**superseded** → A `transition` event with `action: "supersede"` exists. The `replaced_by` field points to the new decision. The `pain_points` array captures what went wrong. Superseded decisions are still queryable (for historical context and abandoned-approach prevention) but the MCP server returns the replacement alongside them.

**abandoned** → A `transition` event with `action: "abandon"` exists. The decision was tried and rejected. The record exists specifically to prevent the same approach from being tried again.

**expired** → A `transition` event with `action: "expire"` exists. The decision had `durability: "temporary-workaround"` and its `revisit_conditions` were met.

**Conflict detection:** When a new decision is proposed in the same scope as an existing active decision, the agent analyzes the `decision` text semantically to determine if they conflict. If they do, the capture process asks whether the old decision should be superseded or if both address different sub-concerns within the same scope.

**Stale decision detection (v2 addition):** Periodic (or on-demand) validation cross-references `affected_files` against the actual filesystem and agent-guard inventories. Decisions pointing at files that no longer exist get flagged for review, not auto-expired — the convention may still apply even if the specific file was renamed.

---

## Post-Commit Hook Specification

**v2 change:** The hook is now explicitly instantaneous and deterministic. Zero LLM calls. Zero network calls. It reads git metadata and writes structured JSON to the inbox. Target execution time: under 100ms.

The hook runs as a post-commit hook (not pre-commit) to avoid interfering with agent-guard's pre-commit hook. It reads `git diff HEAD~1 --name-only --diff-filter=ACDMR` to see what changed in the committed diff.

### Classification Logic

| Change Pattern | Tier | Detection Method |
|---|---|---|
| `package.json` dependency additions/removals | Draft | Parse JSON diff for `dependencies`/`devDependencies` changes |
| `.env.example` additions/removals | Draft | Line diff |
| New directory created (detected by new files in paths that didn't exist) | Draft | Path analysis |
| Files deleted or directories removed | Draft | `--diff-filter=D` |
| Config files changed (tsconfig, eslint, CI) | Draft | Path pattern match |
| New route files created (`src/app/api/**`, `src/app/**/page.*`) | Draft | Path pattern match |
| Schema/migration files changed | Must Ask | Path pattern match |
| Changes that trigger contradiction signals | Must Ask | Commit touches files in same scope as active precedent AND includes structural signals (dependency swap, directory deletion+creation, migration replacement) |
| Module replacement (directory deleted + new directory created in same commit) | Must Ask | Deletion + creation heuristic |

### What Gets Ignored

- Content changes within existing files that don't create new directories or delete files
- Test files (unless a new test directory is created)
- Style/formatting changes
- Documentation updates (agent-guard's territory)
- Files matching `ignore_paths` in config
- Commits with message containing `[no-capture]` (escape hatch)

### Coexistence with agent-guard

agent-guard uses a pre-commit hook. context-ledger uses a post-commit hook. No conflict. Different git hook phases, different purposes.

`context-ledger init` detects existing hook systems (Husky, Lefthook, simple-git-hooks, bare `.git/hooks/`) and integrates accordingly rather than assuming Husky.

### Security and Redaction

**v2 addition.** Both reviewers flagged the risk of capturing sensitive content from diffs.

`config.json` includes a `redact_patterns` array of regexes. The hook strips matching content from `diff_summary` and `commit_message` before writing to `inbox.jsonl`. Defaults include patterns for API keys, tokens, passwords, and common secret formats.

```jsonc
{
  "capture": {
    "redact_patterns": [
      "(?i)(api[_-]?key|secret|token|password)\\s*[:=]\\s*\\S+",
      "sk-[a-zA-Z0-9]{20,}",
      "AIza[a-zA-Z0-9_-]{35}"
    ]
  }
}
```

---

## Configuration

`.context-ledger/config.json`:

```jsonc
{
  "capture": {
    "enabled": true,
    "ignore_paths": ["dist/", "node_modules/", ".next/", "coverage/"],
    "scope_mappings": {
      "src/lib/queries/": { "type": "domain", "id": "query-layer" },
      "src/providers/": { "type": "domain", "id": "providers" },
      "src/app/api/": { "type": "domain", "id": "api-routes" },
      "src/types/": { "type": "concern", "id": "type-definitions" }
    },
    "redact_patterns": ["..."],
    "no_capture_marker": "[no-capture]",
    "inbox_ttl_days": 14,
    "inbox_max_prompts_per_item": 3,
    "inbox_max_items_per_session": 3
  },
  "retrieval": {
    "default_limit": 20,
    "include_superseded": false,
    "include_unreviewed": false,
    "auto_promotion_min_weight": 0.7,
    "feature_hint_mappings": {
      "drill-down": ["query-layer"],
      "export": ["export-format"],
      "csv": ["export-format"],
      "sheets": ["export-format"],
      "pipeline": ["pipeline-queries"],
      "explore": ["explore-results"],
      "SGA": ["sga-hub"],
      "forecast": ["forecast-engine"]
    }
  },
  "workflow_integration": {
    "selective_writeback": true,
    "check_inbox_on_session_start": true,
    "jit_backfill": true
  },
  "monorepo": {
    "package_name": null,
    "root_relative_path": null
  }
}
```

**v2 addition: monorepo namespace fields.** v1 is explicitly single-repo. These fields exist for forward compatibility. If populated, they're included in all decision records and used to scope MCP queries.

---

## npm Package Design

```jsonc
{
  "name": "context-ledger",
  "version": "0.1.0",
  "bin": {
    "context-ledger": "dist/cli.js",
    "context-ledger-mcp": "dist/mcp-server.js",
    "context-ledger-setup": "dist/setup.js"
  },
  "files": ["dist/", "examples/", "README.md", "QUICKSTART.md"],
  "engines": { "node": ">=18.0.0" },
  "dependencies": {
    "@clack/prompts": "^1.1.0"
  }
}
```

One runtime dependency (`@clack/prompts` for the interactive setup wizard), matching council-mcp's precedent. All other runtime code uses Node built-ins only.

**CLI commands:**
- `context-ledger init` — creates `.context-ledger/` directory, config, installs post-commit hook (detects existing hook system)
- `context-ledger serve` — starts MCP server over stdio
- `context-ledger query <query>` — CLI query for debugging
- `context-ledger stats` — summary (total records by source, kind, scope, evidence type, verification status)
- `context-ledger export --format json|csv` — dump ledger for analysis
- `context-ledger validate` — check integrity (valid JSON, no orphaned transition targets, lifecycle state machine violations, stale file references cross-checked against filesystem)
- `context-ledger validate --propose-repair` — generate a reviewable repair plan: suggested deduplication, flagged contradictory active decisions in same scope, suggested scope alias updates from git rename history. Outputs plan to stdout. Does not modify any files.
- `context-ledger validate --apply-repair` — apply a previously reviewed repair plan with explicit opt-in
- `context-ledger tidy` — compact `inbox.jsonl` by removing terminal entries (dismissed, expired, ignored) older than 30 days
- `context-ledger backfill --max 5` — optional batch backfill, capped per session
- `context-ledger backfill --resume` — resume a previously interrupted backfill session
- `context-ledger setup` — interactive setup wizard (project detection, scope mapping, hook installation, standing instructions, first-run demo)

**Example slash command templates shipped in `examples/`:**
- `decision.md` — manual capture
- `check-decisions.md` — query ledger for current task context

These are documentation and templates, not installed automatically. The developer copies them into `.claude/commands/` if they want them, or the standing instructions snippets handle the integration without dedicated commands.

### Interactive Setup Wizard (`context-ledger setup`)

An interactive CLI wizard built with `@clack/prompts` (same library used by council-mcp-setup) that walks new users through full project onboarding. Exposed as the primary setup entry point.

Note: `@clack/prompts` is the ONE allowed runtime dependency exception, matching council-mcp's precedent. All other runtime code remains zero-dependency Node built-ins only.

**What it does (5 steps):**

1. **Project Detection** — Reads `package.json`, detects tech stack (Next.js, TypeScript, Python, etc.), checks for existing `.claude/` directory, checks for agent-guard installation, checks for council-mcp registration. Shows a project summary with checkmarks for what's detected.

2. **Scope Mapping Generation** — Scans the project directory tree and auto-generates `scope_mappings` based on actual directories. Presents the suggested mappings: "I found `src/lib/queries/`, `src/providers/`, `src/app/api/`, and 4 others. Here's what I'd map them to." Developer confirms, adjusts, or adds custom mappings. Also generates `feature_hint_mappings` suggestions based on directory names and common patterns.

3. **Hook Installation** — Detects existing hook system (Husky, Lefthook, simple-git-hooks, bare `.git/hooks/`). Shows what it found. Installs the post-commit hook into the correct system. If agent-guard's pre-commit hook is detected, confirms coexistence and explains the different hook phases.

4. **Standing Instructions Injection** — Detects `CLAUDE.md`, `.cursorrules`, or other agent config files. Injects the context-ledger integration snippet (inbox check, `query_decisions` usage, write-back rules). If agent-guard standing instructions exist, appends context-ledger instructions below them with the correct loading order.

5. **First-Run Demo** — If the developer chose to do a quick backfill (see below), runs a sample `query_decisions` call against the captured records and displays the decision pack the agent would see. "Here's what Claude Code will know about your project next session." If no backfill was done, shows an example of what a decision pack looks like and explains when it will start populating.

At the end, prints a clear next-steps message with the commands available.

### Guided Backfill Mode

After setup completes, the wizard offers an optional guided backfill:

"Want to capture some history? I found [N] structural commits in the last 90 days. We can walk through them by area — takes about 5-10 minutes, and you can stop anytime."

If the developer says yes:

1. Groups structural commits by detected scope area (not a flat chronological list).
2. Presents one area at a time: "Query Layer: 3 structural commits. Want to review these?"
3. For each commit in an area, shows the diff summary and a draft decision. Developer confirms, corrects, or skips.
4. Saves progress after each area so the developer can quit and resume later with `context-ledger backfill --resume`.
5. After each area, shows a running count: "4 decisions captured. 2 areas remaining. Continue?"
6. At the end (or when the developer stops), runs the first-run demo showing what was captured.

The backfill is also available standalone via `context-ledger backfill` for developers who skipped it during setup or want to capture more history later.

---

## Design Decisions Made in This Document

These are the arbitrated outcomes from adversarial review. v2 decisions are from Round 1 (GPT + Gemini). v2.1 decisions are from Round 2.

| Decision | Rationale | Source |
|---|---|---|
| Kill Tier 1 auto-write | Unverified intent written as "high confidence" poisons ground truth | Both R1 reviewers |
| Event-sourced JSONL | Append-only storage can't have mutable status fields. Transition events solve this cleanly. | Both R1 reviewers |
| Structured inbox replaces pending.md | Markdown is wrong for workflow state. Need TTL, priority, staleness tracking. | Both R1 reviewers |
| LLM-based retrieval over keyword matching | Keyword tokenization fails on semantically related but lexically divergent queries. The LLM is already in the loop. | Both R1 reviewers |
| Hook is instantaneous and dumb | Zero LLM calls in git hooks. Queue metadata, process async. | GPT R1 |
| Scoped records with scope_aliases | Raw file paths break on refactor. Scope type+id with aliases provides rename resilience. | Gemini R1 |
| Evidence type + verification status + retrieval weight | Replaces vague "confidence" string. Enables trust-based auto-promotion with defined thresholds. | Gemini R1 |
| Selective write-back with durability classification | Not every Phase 4 answer is permanent precedent. Classify before capture. | Both R1 reviewers |
| JIT backfill over batch interview | Batch backfill produces low-quality retrospective rationalization and developer abandonment. Capture at the moment of relevance. | GPT R1 |
| Pain points on supersedence transitions | Highest-signal data for preventing repeated mistakes. | GPT R1 |
| Decision packs over flat rows | Bundled retrieval (active, superseded, abandoned, gaps) fits agent workflow better. | Gemini R1 |
| "No precedent found" as explicit signal | Absence of precedent should trigger Bucket 2 flagging, not silent approach selection. | Gemini R1 |
| Narrow MCP write tools | Structured operations (propose, confirm, supersede, reject) not arbitrary freeform writes. | Gemini R1 |
| Agent-guard integration for stale detection | Use deterministic inventories to validate scope targets. | Gemini R1 |
| Secrets redaction in hook | Diffs can contain sensitive content that shouldn't be git-tracked in the inbox. | Gemini R1 |
| Solo dev first, explicitly | Stop hedging about team support. Design honestly for one developer. | Gemini R1 |
| Monorepo namespace fields for forward compat | Don't build monorepo support in v1, but add fields now so retrofitting doesn't require migration. | Both R1 reviewers |
| Reject local embeddings for v1 | Adds a heavy dependency. LLM-in-the-loop handles semantic matching at solo-dev scale. | Arbiter R1 |
| Reject file watcher daemon for v1 | Over-engineered. Post-commit queue is simpler and sufficient. Note for v2+. | Arbiter R1 |
| Post-commit hook, not pre-commit | Avoids conflict with agent-guard. Post-commit sees final committed state. | Arbiter R1 |
| **v2.1: Strict lifecycle state machine** | Transition semantics were underspecified. Legal paths, invariants, and cycle prevention defined. | GPT R2 |
| **v2.1: Freeform decision_kind, not enum** | LLMs can't consistently categorize into 12 rigid buckets. Freeform labels with semantic conflict detection. | Gemini R2 |
| **v2.1: File-path-first retrieval with server-side scope derivation** | Agents shouldn't guess scope taxonomy. Server derives scope from file path via config mappings and directory fallback. | Both R2 reviewers |
| **v2.1: Broad fallback for query-only calls** | If no file_path or scope provided, return recent active precedents so LLM can scan. Prevents false "no precedent" from wrong parameters. | Gemini R2 |
| **v2.1: Token budgeting on decision packs** | Decision packs must not recreate context bloat. Configurable budget, priority-ordered trimming, truncation flag. | GPT R2 |
| **v2.1: Idempotency keys on all MCP writes** | Prevents duplicate decisions and transitions from retry/race conditions. | GPT R2 |
| **v2.1: Separate inbox terminal states** | dismissed/expired/ignored are distinct signals for classifier quality. Not collapsed into one. | GPT R2 |
| **v2.1: Inbox check embedded in /auto-feature** | Standing instructions alone won't trigger inbox review. Must be unskippable first step in pipeline. | Gemini R2 |
| **v2.1: Multiple inbox items per mixed commit** | Single queue item per commit conflates unrelated decisions. Emit per change cluster. | GPT R2 |
| **v2.1: Correction metadata on drafts** | Storing what was wrong and why preserves signal for improving future classification. | GPT R2 |
| **v2.1: review_after date on temporary workarounds** | Freeform revisit_conditions aren't machine-actionable. Date enables proactive surfacing. | GPT R2 |
| **v2.1: Feature-local auto-demotion** | Excluded from default queries, auto-expire at 60 days. Prevents retrieval pollution. | GPT R2 |
| **v2.1: Scope mapping directory fallback** | Developers won't maintain scope_mappings. Unmapped directories use top-level name automatically. | Gemini R2 |
| **v2.1: validate --propose-repair, not auto-repair** | Near-duplicate detection is non-deterministic. Must be reviewable before applying. | GPT R2 |
| **v2.1: Conservative contradiction detection** | Semantic contradiction from arbitrary diffs is unreliable. Only trigger Must Ask on structural signals (deletion+creation, dependency swap) within same scope. | Arbiter R2 |
| **v2.1: Downgraded merge safety claim** | JSONL append-only doesn't magically auto-merge in all git scenarios. Honest about limitations. | GPT R2 |
| **v2.2: Two-pass /new-feature integration** | Affected files aren't known until exploration runs. Pre-exploration broad query + post-discovery file-path re-query. | GPT R3 |
| **v2.2: Targeted decision pack subsets per teammate** | Each exploration agent gets precedents relevant to its specialty, not a generic dump. | GPT R3 |
| **v2.2: Recommended decision-kind vocabulary** | Freeform labels need suggested vocabulary to prevent retrieval splintering across synonyms. | GPT R3 |
| **v2.2: Write-back deduplication with reinforce events** | Repeated Phase 4 answers should reinforce existing precedent, not clone it. New reinforce transition event type. | GPT R3 |
| **v2.2: Agent-guard boundary contract** | Define explicit ownership boundary between agent-guard (factual state) and context-ledger (rationale). Prevent overlapping context surfaces. | GPT R3 |
| **v2.2: Scope-derived broad fallback** | Pure recency fallback is weak. Derive scope candidates from feature description keywords before falling back to recent precedents. | GPT R3 |
| **v2.3: Bounded reinforce ranking formula** | Reinforcement adds +0.05 per event, capped at +0.15 total. Never changes base trust or overrides lifecycle rules. | Both R4 reviewers |
| **v2.3: Deterministic feature_hint_mappings for fallback** | Query-only retrieval uses configurable phrase-to-scope mapping before pure recency. Eliminates non-deterministic keyword vibes. | GPT R4 |
| **v2.3: Executable /new-feature integration contract** | Five-step sequence (inbox → Pass A → spawn → Pass B → synthesis) replaces descriptive prose. Inbox check runs for both /new-feature and /auto-feature. | GPT R4 |
| **v2.3: record_writeback reinforce-first preference** | Write-back prefers reinforce over new record creation when reaffirming existing precedent. | Gemini R4 |
| **v2.3: reinforce schema consistency** | Reinforce events use same base schema as all transitions (id, created, reason). No special keys. | Gemini R4 |
| **v2.3: Interactive setup wizard** | Setup should be guided and delightful, not a flat CLI command. Auto-generates scope_mappings from project structure. Matches council-mcp-setup UX pattern. | Arbiter |
| **v2.3: Guided area-based backfill** | Backfill grouped by scope area with save/resume, not a flat chronological chore. Developer stops anytime. | Arbiter |
| **v2.3: First-run demo after setup** | Show the developer what their agent will see. Immediate value demonstration closes the "why should I bother" gap. | Arbiter |
| **v2.4: `mistakes_in_scope` in decision pack** | Antipatterns (abandoned, superseded with pain_points, rejected inbox items) are the highest-signal-per-token data for preventing repeats. Surfaced first in the pack and last to be trimmed under token pressure. Retrieval-contract extension only — no new event types. | Arbiter (user triage, council pass 1 — Gemini + Codex) |
| **v2.4: Option A trim order — mistakes last** | Literal spec reading: `active_precedents` (from tail) → `recently_superseded` → `abandoned_approaches` → `pending_inbox_items` (cap + pop) → `mistakes_in_scope` last. A heavily truncated pack can return all mistakes and zero active precedents; this is intentional. | Arbiter (user triage) |
| **v2.4: `include_feature_local` query parameter** | Boolean flag that opts into `feature-local` durability records across every section of the decision pack. Bypasses the default file-path-match requirement globally. | Arbiter (user triage) |
| **v2.4: Recency-fallback rejected-inbox cap** | When scope derivation returns null, include the N=10 most recent dismissed inbox items with `rejection_reason`, sorted by `rejected_at` desc. Honors "apply to every scope-derivation path" contract. | Arbiter (user triage) |
| **v2.4: `rejection_reason` ratified as typed optional field on `InboxItem`** | Previously persisted via out-of-schema dynamic cast at `write-tools.ts:261`. Promoted to `rejection_reason?: string` on the documented `InboxItem` interface; dynamic cast removed. Rationale: eliminates the cast and lets retrieval consume the field with full type safety. **Not an event-schema change** — `InboxItem` is a workflow queue entry, distinct from `DecisionRecord` / `TransitionEvent`. Append-only invariant applies to `ledger.jsonl` events; `inbox.jsonl` already uses atomic `rewriteInbox` for terminal-state transitions. Backward compatible: pre-ratification items parse correctly under the new typed interface (optional field, existing values persist). | Arbiter (user triage, council pass 1) |
| **v2.4: CLI `query` replaces `searchDecisions` with `queryDecisions`** | Single retrieval path for both MCP and CLI. CLI renders the full decision pack (mistakes first, then active, abandoned, superseded, inbox). The CLI becomes a faithful debugging mirror of what the agent sees. `searchDecisions` retained as a library export for other callers. | Arbiter (user triage) |
| **v2.4.1: Inbox draft-payload key unified on `proposed_record`** | Pre-v1.2.1, the hook drafter wrote under `proposed_decision` and MCP `propose_decision` wrote under `proposed_record` — two shapes in the same `inbox.jsonl` forced every consumer to branch on which key was present. Unified on `proposed_record`; readers fall back to `proposed_decision` for legacy items (forward-migrate-on-read, no batch migration). Purely additive — `InboxItem` gains `proposed_record?: ProposedDecisionDraft` alongside the existing optional `proposed_decision?`. Append-only invariant unaffected — `inbox.jsonl` is a workflow queue, not an event log. | dogfood 2026-04-19 |
| **v2.4.1: Hook-drafted inbox items populate scope fields** | Pre-v1.2.1, hook-drafted inbox items emitted `proposed_decision` payloads without `scope_type`, `scope_id`, `affected_files`, or `scope_aliases`. Those drafts were orphans — invisible to file-path queries, to `mistakes_in_scope`, and to scope-derived retrieval. Fixed by calling the existing `deriveScope` helper at draft time and enriching the payload. Highest-impact of the four dogfood bugs: the hook is the dominant capture path and its drafts now retrieve correctly. | dogfood 2026-04-19 |
| **v2.4.1: Same-day revert suppression** | Hook drafter suppresses drafts when a feat+revert pair lands inside a configurable window (default 24h, `capture.drafter.revert_suppression_window_hours`). Suppression is body-keyed (`This reverts commit <40-char SHA>`), not subject-keyed — robust to `--no-edit`, manual rewrites, and cherry-picked reverts. Uses committer date (`%ct`) to avoid cherry-pick ambiguity. Fails open on git errors: the drafter proceeds normally rather than silently skipping. Timing semantics: suppression halves the noise (the revert's draft is skipped), it does not retroactively erase the feat's draft — that would require rewriting `inbox.jsonl` and violate append-only. | dogfood 2026-04-19 |
| **v2.4.1: Editor-backup file-deletion suppression** | `file-deletion` Tier 1 classifier skips commits whose every deletion matches a configurable editor-backup glob (`capture.classifier.editor_backup_patterns`, default: `*.bak`, `*.orig`, `*.swp`, `*.swo`, `*~`, `.#*`, `.DS_Store`, `Thumbs.db`). Mixed commits (backup + real source deletion) still classify the real deletion. Patterns are filename-segment-only — path prefixes in globs are ignored. Narrow scope: Tier 2 detectors (module replacement, feature removal, auth-security) remain unaffected in v2.4.1; widen in a follow-up if dogfood shows noise there. | dogfood 2026-04-19 |

---

## Success Criteria

context-ledger succeeds if:

1. **Bucket 2 questions decrease over time.** The 20th feature built through `/auto-feature` should have fewer human input gates than the 1st.
2. **Zero repeated abandoned approaches.** If an approach was tried and abandoned with a recorded rationale and pain_points, no agent should propose it again.
3. **Capture friction is under 15 seconds per commit.** Hook is instant. Inbox confirmation is a yes/no. Must-ask is one targeted question.
4. **Retrieval returns relevant context.** Decision packs surface applicable precedent for the current task without flooding the context with noise.
5. **The developer never writes a decision record from scratch.** The system always drafts; the developer only confirms, corrects, or answers targeted questions.
6. **Inbox never exceeds 5 actionable items.** TTL, max prompts, and session caps prevent backlog accumulation.
7. **No unreviewed record ever drives autonomous behavior.** The retrieval weight threshold (>= 0.7) is enforced at every auto-promotion decision point.
