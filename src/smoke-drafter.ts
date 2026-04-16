// context-ledger — live smoke for the drafter
// Loads .env, calls synthesizeDraft() against the real Anthropic API with a
// fixture commit context, pretty-prints the result, and exits 0 on success.
// Requires ANTHROPIC_API_KEY to be present in the environment or .env file.

import { config as loadDotenv } from "dotenv";
import { synthesizeDraft } from "./capture/drafter.js";
import type { ProposedDecision } from "./capture/drafter.js";

loadDotenv();

const FIXTURE_DIFF = `diff --git a/src/auth/hash.ts b/src/auth/hash.ts
index 1111111..2222222 100644
--- a/src/auth/hash.ts
+++ b/src/auth/hash.ts
@@ -1,17 +1,22 @@
-import bcrypt from "bcrypt";
+import { scrypt as scryptCb, randomBytes, timingSafeEqual } from "node:crypto";
+import { promisify } from "node:util";
+
+const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, keylen: number) => Promise<Buffer>;

 export async function hashPassword(plain: string): Promise<string> {
-  return bcrypt.hash(plain, 12);
+  const salt = randomBytes(16);
+  const derived = await scrypt(plain, salt, 64);
+  return \`scrypt$\${salt.toString("hex")}$\${derived.toString("hex")}\`;
 }

 export async function verifyPassword(plain: string, stored: string): Promise<boolean> {
-  return bcrypt.compare(plain, stored);
+  const [tag, saltHex, keyHex] = stored.split("$");
+  if (tag !== "scrypt") return false;
+  const salt = Buffer.from(saltHex, "hex");
+  const expected = Buffer.from(keyHex, "hex");
+  const actual = await scrypt(plain, salt, expected.length);
+  return timingSafeEqual(actual, expected);
 }
diff --git a/package.json b/package.json
index aaa..bbb 100644
--- a/package.json
+++ b/package.json
@@ -12,7 +12,6 @@
     "express": "^4.19.0",
-    "bcrypt": "^5.1.1",
     "pg": "^8.11.0"
   },
`;

function printDraft(draft: ProposedDecision): void {
  console.log("\n── Proposed Decision ────────────────────────────────────────");
  console.log(`summary       : ${draft.summary}`);
  console.log(`decision_kind : ${draft.decision_kind}`);
  console.log(`durability    : ${draft.durability}`);
  console.log(`tags          : ${draft.tags.join(", ")}`);
  console.log(`\ndecision:\n  ${draft.decision}`);
  console.log(`\nrationale:\n  ${draft.rationale}`);
  if (draft.alternatives_considered.length > 0) {
    console.log("\nalternatives_considered:");
    for (const alt of draft.alternatives_considered) {
      console.log(`  - approach     : ${alt.approach}`);
      console.log(`    why_rejected : ${alt.why_rejected}`);
      console.log(`    failure_cond : ${alt.failure_conditions ?? "(none)"}`);
    }
  }
  console.log("─────────────────────────────────────────────────────────────\n");
}

function assertField(cond: boolean, label: string, fails: string[]): void {
  if (!cond) fails.push(label);
}

async function main(): Promise<void> {
  const apiKey = process.env.ANTHROPIC_API_KEY ?? null;
  if (!apiKey) {
    console.error("ANTHROPIC_API_KEY is not set (checked .env and environment).");
    process.exit(1);
  }

  const draft = await synthesizeDraft({
    commitSha: "deadbeef",
    commitMessage: "security: switch password hashing from bcrypt to scrypt\n\nAvoids native build failures on alpine CI images by using node:crypto.\nAll new hashes use the scrypt$ prefix; bcrypt verify path will be removed\nonce legacy hashes rotate out.",
    changeCategory: "auth-security-change",
    changedFiles: ["src/auth/hash.ts", "package.json"],
    diff: FIXTURE_DIFF,
    existingPrecedents: [
      {
        summary: "Password hashing uses bcrypt with cost factor 12",
        decision:
          "Hash passwords with bcrypt (cost 12) on creation; verify with bcrypt.compare on login.",
      },
    ],
    config: { apiKey },
  });

  if (!draft) {
    console.error("synthesizeDraft returned null (expected a real draft).");
    process.exit(1);
  }

  printDraft(draft);

  const fails: string[] = [];
  assertField(typeof draft.summary === "string" && draft.summary.length > 0, "summary non-empty", fails);
  assertField(typeof draft.decision === "string" && draft.decision.length > 0, "decision non-empty", fails);
  assertField(typeof draft.rationale === "string" && draft.rationale.length > 0, "rationale non-empty", fails);
  assertField(typeof draft.decision_kind === "string" && draft.decision_kind.length > 0, "decision_kind non-empty", fails);
  assertField(Array.isArray(draft.tags) && draft.tags.length > 0, "tags non-empty", fails);
  assertField(
    draft.durability === "precedent" ||
      draft.durability === "feature-local" ||
      draft.durability === "temporary-workaround",
    "durability is one of the enum values",
    fails,
  );
  assertField(Array.isArray(draft.alternatives_considered), "alternatives_considered is an array", fails);

  if (fails.length > 0) {
    console.error("FAILED assertions:");
    for (const f of fails) console.error(`  - ${f}`);
    process.exitCode = 1;
    return;
  }

  console.error("smoke:drafter OK");
  process.exitCode = 0;
}

main().catch((err) => {
  console.error(`FATAL: ${err instanceof Error ? err.stack : String(err)}`);
  process.exitCode = 1;
});
