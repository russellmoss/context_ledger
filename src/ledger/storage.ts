// context-ledger — ledger/storage
// Append-only JSONL read/write functions and path helpers.

import { readFile, appendFile, writeFile, rename, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { LedgerEvent, InboxItem } from "./events.js";

// ── Path Helpers ──────────────────────────────────────────────────────────────

export function ledgerDir(projectRoot: string): string {
  return join(projectRoot, ".context-ledger");
}

export function ledgerPath(projectRoot: string): string {
  return join(ledgerDir(projectRoot), "ledger.jsonl");
}

export function inboxPath(projectRoot: string): string {
  return join(ledgerDir(projectRoot), "inbox.jsonl");
}

export function configPath(projectRoot: string): string {
  return join(ledgerDir(projectRoot), "config.json");
}

// ── Internal Helpers ──────────────────────────────────────────────────────────

async function ensureLedgerDir(projectRoot: string): Promise<void> {
  await mkdir(ledgerDir(projectRoot), { recursive: true });
}

// ── Write Functions ───────────────────────────────────────────────────────────

export async function appendToLedger(event: LedgerEvent, projectRoot: string): Promise<void> {
  await ensureLedgerDir(projectRoot);
  await appendFile(ledgerPath(projectRoot), JSON.stringify(event) + "\n", "utf8");
}

export async function appendToInbox(item: InboxItem, projectRoot: string): Promise<void> {
  await ensureLedgerDir(projectRoot);
  await appendFile(inboxPath(projectRoot), JSON.stringify(item) + "\n", "utf8");
}

// ── Read Functions ────────────────────────────────────────────────────────────

export async function readLedger(projectRoot: string): Promise<LedgerEvent[]> {
  const filePath = ledgerPath(projectRoot);
  let content: string;
  try {
    content = await readFile(filePath, "utf8");
  } catch (err: any) {
    if (err.code === "ENOENT") return [];
    throw err;
  }

  const events: LedgerEvent[] = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === "") continue;
    try {
      events.push(JSON.parse(line) as LedgerEvent);
    } catch {
      console.error(`Warning: malformed JSONL line ${i + 1} in ${filePath}`);
    }
  }
  return events;
}

export async function readInbox(projectRoot: string): Promise<InboxItem[]> {
  const filePath = inboxPath(projectRoot);
  let content: string;
  try {
    content = await readFile(filePath, "utf8");
  } catch (err: any) {
    if (err.code === "ENOENT") return [];
    throw err;
  }

  const items: InboxItem[] = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === "") continue;
    try {
      items.push(JSON.parse(line) as InboxItem);
    } catch {
      console.error(`Warning: malformed JSONL line ${i + 1} in ${filePath}`);
    }
  }
  return items;
}

// ── Rewrite Function (tidy command only) ──────────────────────────────────────

export async function rewriteInbox(items: InboxItem[], projectRoot: string): Promise<void> {
  await ensureLedgerDir(projectRoot);
  const tmpPath = inboxPath(projectRoot) + ".tmp";
  await writeFile(tmpPath, items.map(i => JSON.stringify(i)).join("\n") + "\n", "utf8");
  await rename(tmpPath, inboxPath(projectRoot));
}
