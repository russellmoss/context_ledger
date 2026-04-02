// context-ledger — ledger/inbox
// Inbox management: tidy, expire, query, and update operations.

import type { InboxItem } from "./events.js";
import { readInbox, rewriteInbox } from "./storage.js";
import { loadConfig } from "../config.js";

const TERMINAL_STATUSES = new Set(["dismissed", "expired", "ignored"]);

/**
 * Remove terminal inbox entries older than maxAgeDays. Also expires
 * pending items past TTL and ignores over-prompted items before filtering.
 */
export async function tidyInbox(
  projectRoot: string,
  maxAgeDays = 30,
): Promise<{ removed: number; remaining: number }> {
  const inbox = await readInbox(projectRoot);
  const now = Date.now();
  const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
  const config = await loadConfig(projectRoot);

  // First: transition pending items that should expire/ignore
  const processed = inbox.map((item) => {
    if (item.status !== "pending") return item;
    if (new Date(item.expires_after).getTime() < now) {
      return { ...item, status: "expired" as const };
    }
    if (item.times_shown >= config.capture.inbox_max_prompts_per_item) {
      return { ...item, status: "ignored" as const };
    }
    return item;
  });

  // Filter out terminal entries older than maxAgeDays
  const kept = processed.filter((item) => {
    if (!TERMINAL_STATUSES.has(item.status)) return true;
    const age = now - new Date(item.created).getTime();
    return age < maxAgeMs;
  });

  const removed = inbox.length - kept.length;
  if (removed > 0) {
    await rewriteInbox(kept, projectRoot);
  }

  return { removed, remaining: kept.length };
}

/**
 * Expire pending items past their TTL and ignore over-prompted items.
 */
export async function expireStaleItems(
  projectRoot: string,
): Promise<{ expired: number }> {
  const inbox = await readInbox(projectRoot);
  const now = Date.now();
  const config = await loadConfig(projectRoot);
  let expiredCount = 0;

  const updated = inbox.map((item) => {
    if (item.status !== "pending") return item;
    if (new Date(item.expires_after).getTime() < now) {
      expiredCount++;
      return { ...item, status: "expired" as const };
    }
    if (item.times_shown >= config.capture.inbox_max_prompts_per_item) {
      expiredCount++;
      return { ...item, status: "ignored" as const };
    }
    return item;
  });

  if (expiredCount > 0) {
    await rewriteInbox(updated, projectRoot);
  }

  return { expired: expiredCount };
}

/**
 * Get pending inbox items sorted by priority (question_needed first, then recency).
 */
export async function getPendingItems(
  projectRoot: string,
  maxItems = 3,
): Promise<InboxItem[]> {
  const inbox = await readInbox(projectRoot);

  return inbox
    .filter((item) => item.status === "pending")
    .sort((a, b) => {
      // question_needed before draft_needed
      if (a.type !== b.type) {
        return a.type === "question_needed" ? -1 : 1;
      }
      // Then by recency (newest first)
      return new Date(b.created).getTime() - new Date(a.created).getTime();
    })
    .slice(0, maxItems);
}

/**
 * Update a single inbox item by inbox_id. Returns true if found and updated.
 */
export async function updateInboxItem(
  projectRoot: string,
  inboxId: string,
  updates: Partial<InboxItem>,
): Promise<boolean> {
  const inbox = await readInbox(projectRoot);
  const index = inbox.findIndex((item) => item.inbox_id === inboxId);
  if (index === -1) return false;

  inbox[index] = { ...inbox[index], ...updates };
  await rewriteInbox(inbox, projectRoot);
  return true;
}
