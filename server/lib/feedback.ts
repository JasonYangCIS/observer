import { randomUUID } from "node:crypto";
import { fail } from "@agent-native/core/action";
import { and, desc, eq, inArray } from "drizzle-orm";
import { getDb, schema } from "../db/index.js";
import { recomputeSourceTrust } from "./trust.js";

const { feedback, items } = schema;

export const SIGNALS = ["like", "skip", "save", "opened"] as const;
export type Signal = (typeof SIGNALS)[number];

export interface FeedbackState {
  liked: boolean;
  skipped: boolean;
  saved: boolean;
  opened: boolean;
}

export const EMPTY_FEEDBACK: FeedbackState = { liked: false, skipped: false, saved: false, opened: false };

function toState(signals: string[]): FeedbackState {
  const set = new Set(signals);
  return { liked: set.has("like"), skipped: set.has("skip"), saved: set.has("save"), opened: set.has("opened") };
}

/** Feedback state for the given items, keyed by item id (items with none are absent). */
export async function getFeedbackStates(ownerEmail: string, itemIds: string[]): Promise<Map<string, FeedbackState>> {
  const bySignals = new Map<string, string[]>();
  for (let i = 0; i < itemIds.length; i += 100) {
    const rows = await getDb()
      .select({ itemId: feedback.itemId, signal: feedback.signal })
      .from(feedback)
      .where(and(eq(feedback.ownerEmail, ownerEmail), inArray(feedback.itemId, itemIds.slice(i, i + 100))));
    for (const r of rows) bySignals.set(r.itemId, [...(bySignals.get(r.itemId) ?? []), r.signal]);
  }
  return new Map([...bySignals].map(([id, signals]) => [id, toState(signals)]));
}

/**
 * Record or clear one feedback signal on an item.
 *
 * `like` and `skip` are mutually exclusive: setting one clears the other. `save`
 * is independent. `opened` is a fact about what happened, so it can be recorded
 * but not undone. Recording a signal that is already set changes nothing.
 *
 * The item's source trust weight is recomputed from the new history.
 *
 * @returns the item's feedback state after the change.
 * @throws not_found when the item doesn't exist for this owner; cannot_unopen.
 */
export async function recordFeedback(args: {
  ownerEmail: string;
  orgId: string | null;
  itemId: string;
  signal: Signal;
  active?: boolean;
}): Promise<FeedbackState & { itemId: string }> {
  const { ownerEmail, orgId, itemId, signal, active = true } = args;
  const db = getDb();
  const [item] = await db.select({ id: items.id }).from(items).where(and(eq(items.id, itemId), eq(items.ownerEmail, ownerEmail))).limit(1);
  if (!item) fail("Item not found", { errorCode: "not_found", statusCode: 404 });
  if (signal === "opened" && !active) fail("An opened signal can't be undone.", { errorCode: "cannot_unopen" });

  const opposite: Partial<Record<Signal, Signal>> = { like: "skip", skip: "like" };
  await db.transaction(async (tx) => {
    if (active) {
      const other = opposite[signal];
      if (other) await tx.delete(feedback).where(and(eq(feedback.ownerEmail, ownerEmail), eq(feedback.itemId, itemId), eq(feedback.signal, other)));
      await tx
        .insert(feedback)
        .values({ id: randomUUID(), ownerEmail, orgId, itemId, signal })
        .onConflictDoNothing({ target: [feedback.ownerEmail, feedback.itemId, feedback.signal] });
    } else {
      await tx.delete(feedback).where(and(eq(feedback.ownerEmail, ownerEmail), eq(feedback.itemId, itemId), eq(feedback.signal, signal)));
    }
  });
  await recomputeSourceTrust(ownerEmail, itemId);
  return { itemId, ...(await getFeedbackStates(ownerEmail, [itemId])).get(itemId) ?? EMPTY_FEEDBACK };
}

/** Titles of items the user liked/saved and skipped most recently, for calibrating relevance. */
export async function recentFeedbackTitles(ownerEmail: string, perKind = 8): Promise<{ liked: string[]; skipped: string[] }> {
  const fetchTitles = async (signals: Signal[]) => {
    const rows = await getDb()
      .select({ title: items.title })
      .from(feedback)
      .innerJoin(items, and(eq(items.id, feedback.itemId), eq(items.ownerEmail, ownerEmail)))
      .where(and(eq(feedback.ownerEmail, ownerEmail), inArray(feedback.signal, signals)))
      .orderBy(desc(feedback.createdAt))
      .limit(perKind * 2); // an item can be both liked and saved; dedupe below
    return [...new Set(rows.map((r) => r.title))].slice(0, perKind);
  };
  return { liked: await fetchTitles(["like", "save"]), skipped: await fetchTitles(["skip"]) };
}
