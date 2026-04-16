// context-ledger — capture/classify smoke tests
// Standalone script: exit 0 if all pass, exit 1 if any fail.

import { classifyCommit } from "./classify.js";
import { DEFAULT_CONFIG } from "../config.js";

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string): void {
  if (condition) {
    passed++;
    console.error(`  ✓ ${label}`);
  } else {
    failed++;
    console.error(`  ✗ ${label}`);
  }
}

function hasCategory(results: ReturnType<typeof classifyCommit>, cat: string): boolean {
  return results.some((r) => r.change_category === cat);
}

// ── Case 1: .agent-guard/session-context.md alone — no auth-security-change ──
{
  const results = classifyCommit(
    [".agent-guard/session-context.md"],
    [],
    [],
    "chore: update session context",
    DEFAULT_CONFIG,
    null,
  );
  assert(
    !hasCategory(results, "auth-security-change"),
    "session-context.md: no auth-security-change result",
  );
}

// Extra: plain "session-context.tsx" in a non-ignored path — still no auth hit
{
  const results = classifyCommit(
    ["src/components/session-context.tsx"],
    [],
    [],
    "feat: add session context provider",
    DEFAULT_CONFIG,
    null,
  );
  assert(
    !hasCategory(results, "auth-security-change"),
    "session-context.tsx: bare 'session' no longer triggers auth",
  );
}

// Sanity: compound form still matches
{
  const results = classifyCommit(
    ["src/lib/session-store.ts"],
    [],
    [],
    "feat: add session store",
    DEFAULT_CONFIG,
    null,
  );
  assert(
    hasCategory(results, "auth-security-change"),
    "session-store.ts: compound form still triggers auth",
  );
}

// ── Case 2: page.tsx alone — page-route-change (not api-route-change) ───────
{
  const results = classifyCommit(
    ["src/app/dashboard/page.tsx"],
    [],
    [],
    "feat: add dashboard page",
    DEFAULT_CONFIG,
    null,
  );
  assert(
    hasCategory(results, "page-route-change"),
    "page.tsx alone: page-route-change present",
  );
  assert(
    !hasCategory(results, "api-route-change"),
    "page.tsx alone: api-route-change absent",
  );
}

// ── Case 3: route.ts alone — api-route-change ────────────────────────────────
{
  const results = classifyCommit(
    ["src/app/api/users/route.ts"],
    [],
    [],
    "feat: add users API route",
    DEFAULT_CONFIG,
    null,
  );
  assert(
    hasCategory(results, "api-route-change"),
    "route.ts alone: api-route-change present",
  );
  assert(
    !hasCategory(results, "page-route-change"),
    "route.ts alone: page-route-change absent",
  );
}

// ── Case 4: page.tsx + route.ts together — two separate results, no double-claim ──
{
  const files = ["src/app/dashboard/page.tsx", "src/app/api/users/route.ts"];
  const results = classifyCommit(files, [], [], "feat: add page and api", DEFAULT_CONFIG, null);

  const api = results.find((r) => r.change_category === "api-route-change");
  const page = results.find((r) => r.change_category === "page-route-change");
  assert(api !== undefined, "mixed: api-route-change result present");
  assert(page !== undefined, "mixed: page-route-change result present");

  const apiFiles = api?.changed_files ?? [];
  const pageFiles = page?.changed_files ?? [];
  assert(
    apiFiles.includes("src/app/api/users/route.ts") && !apiFiles.includes("src/app/dashboard/page.tsx"),
    "mixed: api result contains only route.ts",
  );
  assert(
    pageFiles.includes("src/app/dashboard/page.tsx") && !pageFiles.includes("src/app/api/users/route.ts"),
    "mixed: page result contains only page.tsx",
  );
  const overlap = apiFiles.filter((f) => pageFiles.includes(f));
  assert(overlap.length === 0, "mixed: no file double-claimed across results");
}

// ── Summary ──────────────────────────────────────────────────────────────────
console.error(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
