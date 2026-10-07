import { and, count, desc, eq, isNull, inArray } from "drizzle-orm";
import { getDb, schema } from "../db/index.js";
import { hasEngagementData } from "./scores.js";

const { items, summaries, scores, sources } = schema;

const HALF_LIFE_MS = 24 * 60 * 60 * 1000;
/** How many of the newest scored items are ranked; the feed shows the top `limit` of them. */
const CANDIDATE_POOL = 300;

/**
 * Parse a stored timestamp. `posted_at` is ISO-8601; `created_at` is Postgres
 * `now()` text such as "2026-10-07 08:50:09.46-08", which JavaScript can't parse
 * as written. Returns null when the value isn't a date at all.
 */
export function parseTimestamp(value: string | null | undefined): number | null {
  if (!value) return null;
  const iso = value.includes("T") ? value : value.replace(" ", "T");
  const padded = iso.replace(/([+-]\d{2})$/, "$1:00");
  const ms = new Date(padded).getTime();
  return Number.isNaN(ms) ? null : ms;
}

/** 1 for a brand-new item, 0.5 after a day, approaching 0 as it ages. Unknown age counts as a day old. */
export function recencyFactor(timestamp: string | null | undefined, now: number): number {
  const ms = parseTimestamp(timestamp);
  const age = ms === null ? HALF_LIFE_MS : Math.max(0, now - ms);
  return Math.pow(0.5, age / HALF_LIFE_MS);
}

/**
 * Order used by the feed: 60% relevance to the user, 20% importance, 20% recency.
 * It only orders items; the UI always shows the underlying scores and reason.
 */
export function rankScore(relevance: number, importance: number, recency: number): number {
  return 0.6 * relevance + 0.2 * importance + 0.2 * 100 * recency;
}

export interface FeedItem {
  id: string;
  title: string;
  url: string;
  discussionUrl: string | null;
  author: string | null;
  postedAt: string | null;
  source: { id: string; name: string; type: string; origin: string };
  summary: { text: string; citationCount: number; articleUnreadable: boolean };
  relevance: number;
  /** 0-100 buzz from real engagement numbers, or null when the source reported none (only a baseline exists). */
  importance: number | null;
  reason: string;
  metrics: { points?: number; comments?: number };
}

export interface FeedProgress {
  sources: number;
  /** Items not yet fetched for article text. */
  needArticle: number;
  /** Items with an article attempt but no summary. */
  needSummary: number;
  /** Summarized items with no score. */
  needScore: number;
  /** Items fully processed and eligible for the feed. */
  ready: number;
}

function readMetrics(raw: string): FeedItem["metrics"] {
  try {
    const m = JSON.parse(raw);
    return {
      ...(typeof m?.points === "number" ? { points: m.points } : {}),
      ...(typeof m?.comments === "number" ? { comments: m.comments } : {}),
    };
  } catch {
    return {};
  }
}

function citationCount(raw: string): number {
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.length : 0;
  } catch {
    return 0;
  }
}

/**
 * The owner's ranked feed: items that are summarized and scored, from enabled
 * sources, best first. Items still being processed are counted in `progress`
 * instead of being shown half-finished.
 */
export async function listFeed(args: { ownerEmail: string; limit: number; sourceId?: string; now?: number }): Promise<{ items: FeedItem[]; progress: FeedProgress }> {
  const { ownerEmail, limit, sourceId, now = Date.now() } = args;
  const db = getDb();

  const rows = await db
    .select({
      item: items,
      summary: summaries,
      score: scores,
      source: sources,
    })
    .from(items)
    .innerJoin(summaries, and(eq(summaries.itemId, items.id), eq(summaries.ownerEmail, ownerEmail)))
    .innerJoin(scores, and(eq(scores.itemId, items.id), eq(scores.ownerEmail, ownerEmail)))
    .innerJoin(sources, and(eq(sources.id, items.sourceId), eq(sources.ownerEmail, ownerEmail), eq(sources.enabled, true)))
    .where(and(eq(items.ownerEmail, ownerEmail), ...(sourceId ? [eq(items.sourceId, sourceId)] : [])))
    .orderBy(desc(items.createdAt))
    .limit(CANDIDATE_POOL);

  const ranked = rows
    .map((r) => ({
      r,
      rank: rankScore(r.score.relevance, r.score.importance, recencyFactor(r.item.postedAt ?? r.item.createdAt, now)),
    }))
    .sort((a, b) => b.rank - a.rank)
    .slice(0, limit);

  return {
    items: ranked.map(({ r }) => ({
      id: r.item.id,
      title: r.item.title,
      url: r.item.url,
      discussionUrl: r.item.discussionUrl,
      author: r.item.author,
      postedAt: r.item.postedAt,
      source: { id: r.source.id, name: r.source.name, type: r.source.type, origin: r.source.origin },
      summary: { text: r.summary.summaryText, citationCount: citationCount(r.summary.citations), articleUnreadable: r.summary.inputHash === null },
      relevance: r.score.relevance,
      importance: hasEngagementData(r.item.rawMetrics) ? r.score.importance : null,
      reason: r.score.reason,
      metrics: readMetrics(r.item.rawMetrics),
    })),
    progress: await feedProgress(ownerEmail),
  };
}

/** How much of the pipeline is still pending, for items from enabled sources. */
export async function feedProgress(ownerEmail: string): Promise<FeedProgress> {
  const db = getDb();
  const enabled = and(eq(items.ownerEmail, ownerEmail), eq(sources.enabled, true));
  const base = () =>
    db
      .select({ n: count() })
      .from(items)
      .innerJoin(sources, and(eq(sources.id, items.sourceId), eq(sources.ownerEmail, ownerEmail)));

  const [sourceCount] = await db
    .select({ n: count() })
    .from(sources)
    .where(and(eq(sources.ownerEmail, ownerEmail), eq(sources.enabled, true)));
  const [needArticle] = await base().where(and(enabled, eq(items.fetchStatus, "pending")));
  const [needSummary] = await base()
    .leftJoin(summaries, and(eq(summaries.itemId, items.id), eq(summaries.ownerEmail, ownerEmail)))
    .where(and(enabled, inArray(items.fetchStatus, ["ok", "failed", "paywalled"]), isNull(summaries.id)));
  const [needScore] = await base()
    .innerJoin(summaries, and(eq(summaries.itemId, items.id), eq(summaries.ownerEmail, ownerEmail)))
    .leftJoin(scores, and(eq(scores.itemId, items.id), eq(scores.ownerEmail, ownerEmail)))
    .where(and(enabled, isNull(scores.id)));
  const [ready] = await base()
    .innerJoin(scores, and(eq(scores.itemId, items.id), eq(scores.ownerEmail, ownerEmail)))
    .innerJoin(summaries, and(eq(summaries.itemId, items.id), eq(summaries.ownerEmail, ownerEmail)))
    .where(enabled);

  return {
    sources: Number(sourceCount.n),
    needArticle: Number(needArticle.n),
    needSummary: Number(needSummary.n),
    needScore: Number(needScore.n),
    ready: Number(ready.n),
  };
}
