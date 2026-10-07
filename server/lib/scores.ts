import { randomUUID } from "node:crypto";
import { fail } from "@agent-native/core/action";
import { and, desc, eq } from "drizzle-orm";
import { getDb, schema } from "../db/index.js";
import { ensureInterestProfile } from "./interests.js";
import { normalizeForMatch } from "./summaries.js";

const { items, summaries, scores, sources } = schema;

export const MIN_REASON_CHARS = 20;
export const MAX_REASON_CHARS = 300;
/** At or above this relevance, the score must cite at least one interest from the profile. */
export const RELEVANCE_NEEDS_INTEREST = 50;
export const BASELINE_IMPORTANCE = 20;

export interface Importance {
  /** 0-100 general buzz, independent of any user's interests. */
  score: number;
  /** Plain-language basis for the number. */
  reason: string;
}

function normalized(value: number, max: number): number {
  return Math.min(1, Math.log1p(Math.max(0, value)) / Math.log1p(max));
}

/** Parse a stored metrics blob into the engagement numbers a source reported, if any. */
function readEngagement(rawMetrics: string): { points: number | null; comments: number | null } {
  let metrics: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(rawMetrics);
    if (parsed && typeof parsed === "object") metrics = parsed;
  } catch {
    // Treated as no metrics.
  }
  return {
    points: typeof metrics.points === "number" ? metrics.points : null,
    comments: typeof metrics.comments === "number" ? metrics.comments : null,
  };
}

/**
 * True when the source reported real engagement numbers, so the importance is a
 * measurement. False means it is only the flat baseline and shouldn't be shown
 * as if it were data.
 */
export function hasEngagementData(rawMetrics: string): boolean {
  const { points, comments } = readEngagement(rawMetrics);
  return points !== null || comments !== null;
}

/**
 * Importance from the engagement numbers the source reported.
 *
 * Deterministic and user-independent: a log-scaled blend of points (70%) and
 * comments (30%) for Hacker News. Sources that report no engagement (plain feeds)
 * get a low baseline and say so, instead of a made-up number. Cross-source
 * presence will feed into this once clustering exists.
 */
export function computeImportance(sourceType: string | null, rawMetrics: string): Importance {
  const { points, comments } = readEngagement(rawMetrics);

  if (points === null && comments === null) {
    return { score: BASELINE_IMPORTANCE, reason: "No engagement data from this source, so importance is a low baseline." };
  }
  const blend = 0.7 * normalized(points ?? 0, 1000) + 0.3 * normalized(comments ?? 0, 500);
  const where = sourceType === "hn" ? " on Hacker News" : "";
  const parts = [points !== null ? `${points} points` : null, comments !== null ? `${comments} comments` : null].filter(Boolean);
  return { score: Math.round(blend * 100), reason: `${parts.join(" and ")}${where}.` };
}

export interface ScoreInput {
  item: { id: string; title: string; url: string; author: string | null; postedAt: string | null };
  source: { name: string; type: string; origin: string; trustWeight: number } | null;
  /** The item's summary, or null if none yet (summarize first). */
  summary: { text: string; articleReadable: boolean } | null;
  importance: Importance;
  /** The user's interest profile, in their own words. */
  interests: string;
  existingScore: { relevance: number; importance: number; reason: string } | null;
}

/**
 * Everything the agent needs to judge one item's relevance, including the
 * deterministic importance it will be stored with.
 *
 * @throws not_found when the item doesn't exist for this owner.
 */
export async function getScoreInput(ownerEmail: string, orgId: string | null, itemId: string): Promise<ScoreInput> {
  const db = getDb();
  const [item] = await db.select().from(items).where(and(eq(items.id, itemId), eq(items.ownerEmail, ownerEmail))).limit(1);
  if (!item) fail("Item not found", { errorCode: "not_found", statusCode: 404 });
  const [source] = await db.select().from(sources).where(and(eq(sources.id, item.sourceId), eq(sources.ownerEmail, ownerEmail))).limit(1);
  const [summary] = await db.select().from(summaries).where(and(eq(summaries.itemId, itemId), eq(summaries.ownerEmail, ownerEmail))).limit(1);
  const [existing] = await db.select().from(scores).where(and(eq(scores.itemId, itemId), eq(scores.ownerEmail, ownerEmail))).limit(1);
  return {
    item: { id: item.id, title: item.title, url: item.url, author: item.author, postedAt: item.postedAt },
    source: source ? { name: source.name, type: source.type, origin: source.origin, trustWeight: source.trustWeight } : null,
    summary: summary ? { text: summary.summaryText, articleReadable: summary.inputHash !== null } : null,
    importance: computeImportance(source?.type ?? null, item.rawMetrics),
    interests: await ensureInterestProfile(ownerEmail, orgId),
    existingScore: existing ? { relevance: existing.relevance, importance: existing.importance, reason: existing.reason } : null,
  };
}

/** Summarized items that have no score yet, newest first. */
export async function listPendingScores(ownerEmail: string, limit: number) {
  const rows = await getDb()
    .select({ id: items.id, title: items.title, url: items.url, scoreId: scores.id })
    .from(items)
    .innerJoin(summaries, and(eq(summaries.itemId, items.id), eq(summaries.ownerEmail, ownerEmail)))
    .leftJoin(scores, and(eq(scores.itemId, items.id), eq(scores.ownerEmail, ownerEmail)))
    .where(eq(items.ownerEmail, ownerEmail))
    .orderBy(desc(items.postedAt), desc(items.createdAt))
    .limit(limit * 4);
  return rows.filter((r) => !r.scoreId).slice(0, limit).map((r) => ({ id: r.id, title: r.title, url: r.url }));
}

/**
 * Interests that don't appear in the profile text. Matching ignores case,
 * spacing, and typography, but a cited interest must be a phrase the user
 * actually wrote, as a whole phrase.
 */
export function findUnknownInterests(profileText: string, matched: string[]): string[] {
  const haystack = normalizeForMatch(profileText);
  return matched.filter((m) => {
    const phrase = normalizeForMatch(m);
    if (!phrase) return true;
    const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Whole-phrase match, so "ai" can't match inside "maintain".
    return !new RegExp(`(^|[^a-z0-9])${escaped}($|[^a-z0-9])`).test(haystack);
  });
}

export interface SaveScoreArgs {
  ownerEmail: string;
  orgId: string | null;
  itemId: string;
  relevance: number;
  matchedInterests: string[];
  reason: string;
}

/**
 * Store a score: the agent's relevance plus the server-computed importance.
 *
 * Requires a summary (so the feed always has one to show). Relevance must be an
 * integer 0-100 with a 20-300 character reason. Every matched interest must be a
 * phrase from the user's profile, and a relevance of 50 or more must cite at
 * least one, so a high score can't float free of what the user said they want.
 * The stored reason reads "<why relevant> Matched: <interests>. Buzz: <basis>".
 *
 * @throws not_found, needs_summary, invalid_score, unknown_interest.
 */
export async function saveScore(args: SaveScoreArgs): Promise<{ itemId: string; relevance: number; importance: number; reason: string }> {
  const { ownerEmail, orgId, itemId } = args;
  const db = getDb();
  const [item] = await db.select().from(items).where(and(eq(items.id, itemId), eq(items.ownerEmail, ownerEmail))).limit(1);
  if (!item) fail("Item not found", { errorCode: "not_found", statusCode: 404 });
  const [summary] = await db.select({ id: summaries.id }).from(summaries).where(and(eq(summaries.itemId, itemId), eq(summaries.ownerEmail, ownerEmail))).limit(1);
  if (!summary) fail("Summarize this item first (get-summary-input, then summarize-item).", { errorCode: "needs_summary" });

  if (!Number.isInteger(args.relevance) || args.relevance < 0 || args.relevance > 100) {
    fail("relevance must be a whole number from 0 to 100.", { errorCode: "invalid_score" });
  }
  const reason = args.reason.trim();
  if (reason.length < MIN_REASON_CHARS || reason.length > MAX_REASON_CHARS) {
    fail(`The reason must be ${MIN_REASON_CHARS}-${MAX_REASON_CHARS} characters (got ${reason.length}).`, { errorCode: "invalid_score" });
  }
  const matched = [...new Set(args.matchedInterests.map((m) => m.trim()).filter(Boolean))];
  const profile = await ensureInterestProfile(ownerEmail, orgId);
  const unknown = findUnknownInterests(profile, matched);
  if (unknown.length > 0) {
    fail(`These matched interests are not in the user's interest profile: ${unknown.map((u) => `"${u}"`).join(", ")}. Quote phrases the user actually wrote.`, {
      errorCode: "unknown_interest",
    });
  }
  if (args.relevance >= RELEVANCE_NEEDS_INTEREST && matched.length === 0) {
    fail(`A relevance of ${RELEVANCE_NEEDS_INTEREST} or more must cite at least one matched interest from the profile.`, { errorCode: "unknown_interest" });
  }

  const [source] = await db.select({ type: sources.type }).from(sources).where(eq(sources.id, item.sourceId)).limit(1);
  const importance = computeImportance(source?.type ?? null, item.rawMetrics);
  const fullReason = `${reason}${/[.!?]$/.test(reason) ? "" : "."}${matched.length ? ` Matched: ${matched.join(", ")}.` : ""} Buzz: ${importance.reason}`;

  await db
    .insert(scores)
    .values({ id: randomUUID(), ownerEmail, orgId, itemId, relevance: args.relevance, importance: importance.score, reason: fullReason })
    .onConflictDoUpdate({
      target: [scores.ownerEmail, scores.itemId],
      set: { relevance: args.relevance, importance: importance.score, reason: fullReason, createdAt: new Date().toISOString() },
    });
  return { itemId, relevance: args.relevance, importance: importance.score, reason: fullReason };
}
