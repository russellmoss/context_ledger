// context-ledger — capture/drafter
// Calls Claude Haiku to synthesize a proposed_decision from a commit's diff +
// message + existing precedents in scope. Never throws; returns null on any
// failure so the post-commit hook can proceed with the empty-placeholder path.

import Anthropic from "@anthropic-ai/sdk";
import type { AlternativeConsidered, Durability } from "../ledger/index.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface DrafterConfig {
  apiKey: string | null;
  model?: string;
  timeoutMs?: number;
  maxDiffChars?: number;
}

export interface ProposedDecision {
  summary: string;
  decision: string;
  rationale: string;
  alternatives_considered: AlternativeConsidered[];
  decision_kind: string;
  tags: string[];
  durability: Durability;
}

export interface SynthesizeDraftArgs {
  commitSha: string;
  commitMessage: string;
  changeCategory: string;
  changedFiles: string[];
  diff: string;
  existingPrecedents: Array<{ summary: string; decision: string }>;
  config: DrafterConfig;
}

// ── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_MODEL = "claude-haiku-4-5-20251001";
const DEFAULT_TIMEOUT_MS = 20000;
const DEFAULT_MAX_DIFF_CHARS = 8000;

const SYSTEM_PROMPT = [
  "You are an architectural-decision archivist for a codebase that uses an",
  "event-sourced decision ledger. You read a single commit (diff + message +",
  "changed files) and the relevant existing precedents for its scope, and you",
  "draft a proposed decision record.",
  "",
  "Your draft must be NOVEL with respect to the existing precedents — do not",
  "restate what is already captured. If the commit reinforces or instantiates",
  "an existing precedent, your summary/decision should make the new wrinkle",
  "explicit (what this commit adds, constrains, or specializes).",
  "",
  "If the commit clearly does NOT warrant a lasting precedent (e.g., a rename,",
  "a trivial dependency bump, a test-only shuffle), STILL produce a draft but",
  "set durability to \"feature-local\" with a terse summary — the reviewer will",
  "reject or promote it. Never refuse to draft.",
  "",
  "Durability values:",
  "- \"precedent\": project-wide convention or load-bearing architectural choice.",
  "- \"feature-local\": narrow, only meaningful inside this feature/module.",
  "- \"temporary-workaround\": a conscious compromise with a known expiry.",
  "",
  "Respond by calling the propose_decision tool exactly once with all fields",
  "filled. No prose before/after the tool call.",
].join("\n");

const PROPOSE_DECISION_TOOL = {
  name: "propose_decision",
  description:
    "Draft a DecisionRecord for this commit. Must be novel vs. existing precedents. Always call this — never decline.",
  input_schema: {
    type: "object" as const,
    additionalProperties: false,
    properties: {
      summary: {
        type: "string",
        description: "One-sentence headline of the decision. <= 140 chars.",
      },
      decision: {
        type: "string",
        description:
          "Concrete statement of what was chosen. Should be specific enough that a future reader can tell if they are about to contradict it.",
      },
      rationale: {
        type: "string",
        description:
          "Why this was chosen. Reference diff evidence or commit intent. 2–5 sentences.",
      },
      alternatives_considered: {
        type: "array",
        description:
          "Alternative approaches that were plausibly in scope. Empty array if none are evident from the diff.",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            approach: { type: "string" },
            why_rejected: { type: "string" },
            failure_conditions: { type: ["string", "null"] },
          },
          required: ["approach", "why_rejected", "failure_conditions"],
        },
      },
      decision_kind: {
        type: "string",
        description:
          "Freeform label. Examples: \"dependency-choice\", \"module-boundary\", \"auth-pattern\", \"data-model\", \"config-convention\".",
      },
      tags: {
        type: "array",
        description: "2–6 short kebab-case topical tags.",
        items: { type: "string" },
      },
      durability: {
        type: "string",
        enum: ["precedent", "feature-local", "temporary-workaround"],
      },
    },
    required: [
      "summary",
      "decision",
      "rationale",
      "alternatives_considered",
      "decision_kind",
      "tags",
      "durability",
    ],
  },
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function truncateDiff(diff: string, maxChars: number): string {
  if (diff.length <= maxChars) return diff;
  return diff.slice(0, maxChars) + "\n...[truncated]";
}

function buildUserMessage(
  args: Omit<SynthesizeDraftArgs, "config"> & { diff: string },
): string {
  const precedents =
    args.existingPrecedents.length === 0
      ? "(none)"
      : args.existingPrecedents
          .map((p, i) => `${i + 1}. ${p.summary}\n   decision: ${p.decision}`)
          .join("\n");

  return [
    `Commit: ${args.commitSha}`,
    `Change category: ${args.changeCategory}`,
    `Changed files:\n${args.changedFiles.map((f) => `  - ${f}`).join("\n") || "  (none)"}`,
    "",
    "Commit message:",
    args.commitMessage || "(empty)",
    "",
    "Existing precedents in this scope:",
    precedents,
    "",
    "Unified diff (may be truncated):",
    "```diff",
    args.diff,
    "```",
    "",
    "Now call propose_decision with a novel draft. If this commit does not",
    "warrant a precedent, mark it feature-local and keep the draft terse.",
  ].join("\n");
}

function logError(err: unknown): void {
  const name = err instanceof Error ? err.name : typeof err;
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[context-ledger:drafter] ${name}: ${message}`);
}

function isValidProposedDecision(input: unknown): input is ProposedDecision {
  if (!input || typeof input !== "object") return false;
  const d = input as Record<string, unknown>;
  if (typeof d.summary !== "string" || d.summary.length === 0) return false;
  if (typeof d.decision !== "string" || d.decision.length === 0) return false;
  if (typeof d.rationale !== "string" || d.rationale.length === 0) return false;
  if (typeof d.decision_kind !== "string" || d.decision_kind.length === 0) return false;
  if (!Array.isArray(d.tags) || !d.tags.every((t) => typeof t === "string")) return false;
  if (d.durability !== "precedent" && d.durability !== "feature-local" && d.durability !== "temporary-workaround") return false;
  if (!Array.isArray(d.alternatives_considered)) return false;
  for (const alt of d.alternatives_considered) {
    if (!alt || typeof alt !== "object") return false;
    const a = alt as Record<string, unknown>;
    if (typeof a.approach !== "string") return false;
    if (typeof a.why_rejected !== "string") return false;
    if (a.failure_conditions !== null && typeof a.failure_conditions !== "string") return false;
  }
  return true;
}

// ── Main Entry Point ─────────────────────────────────────────────────────────

export async function synthesizeDraft(
  args: SynthesizeDraftArgs,
): Promise<ProposedDecision | null> {
  const { config } = args;
  if (!config.apiKey) return null;

  const model = config.model ?? DEFAULT_MODEL;
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxDiffChars = config.maxDiffChars ?? DEFAULT_MAX_DIFF_CHARS;

  const truncatedDiff = truncateDiff(args.diff, maxDiffChars);
  const userMessage = buildUserMessage({
    commitSha: args.commitSha,
    commitMessage: args.commitMessage,
    changeCategory: args.changeCategory,
    changedFiles: args.changedFiles,
    diff: truncatedDiff,
    existingPrecedents: args.existingPrecedents,
  });

  const client = new Anthropic({ apiKey: config.apiKey, timeout: timeoutMs });

  try {
    const response = await client.messages.create({
      model,
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      tools: [PROPOSE_DECISION_TOOL],
      tool_choice: { type: "tool", name: PROPOSE_DECISION_TOOL.name },
      messages: [{ role: "user", content: userMessage }],
    });

    const toolUse = response.content.find(
      (block): block is Extract<typeof block, { type: "tool_use" }> =>
        block.type === "tool_use" && block.name === PROPOSE_DECISION_TOOL.name,
    );
    if (!toolUse) {
      console.error(
        "[context-ledger:drafter] no tool_use block in response — skipping draft",
      );
      return null;
    }

    if (!isValidProposedDecision(toolUse.input)) {
      console.error(
        "[context-ledger:drafter] tool_use input failed schema validation — skipping draft",
      );
      return null;
    }

    console.error("[context-ledger:drafter] ok");
    return toolUse.input;
  } catch (err) {
    logError(err);
    return null;
  }
}
