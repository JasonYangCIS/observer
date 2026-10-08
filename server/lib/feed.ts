import { and, count, desc, eq, isNull, inArray, not } from "drizzle-orm";
import { getDb, schema } from "../db/index.js";
import { isRedundantMember } from "./cluster.js";
import { EMPTY_FEEDBACK, getFeedbackStates, type FeedbackState } from "./feedback.js";
import { BASELINE_IMPORTANCE, computeImportance, hasEngagementData } from "./scores.js";
import { trustRankAdjustment } from "./trust.js";
import { parseTimestamp } from "./time.js";

const { items, summaries, scores, sources, clusters, clusterItems } = schema;

const HALF_LIFE_MS = 24 * 60 * 60 * 1000;
/** How many of the newest scored items are ranked; the feed shows the top `limit` of them. */
const CANDIDATE_POOL = 300;

/** 1 for a brand-new item, 0.5 after a day, approaching 0 as it ages. Unknown age counts as a day old. */
export function recencyFactor(timestamp: string | null | undefined, now: number): number {
  const ms = parseTimestamp(timestamp);
  const age = ms === null ? HALF_LIFE_MS : Math.max(0, now - ms);
  return Math.pow(0.5, age / HALF_LIFE_MS);
}

/**
 * Order used by the feed: 60% relevance to the user, 20% importance, 20% recency,
 * plus up to ±10 points for how much the user trusts the source (from their feedback).
 * It only orders items; the UI always shows the underlying scores and reason.
 */
export function rankScore(relevance: number, importance: number, recency: number, trustWeight = 1): number {
  return 0.6 * relevance + 0.2 * importance + 0.2 * 100 * recency + trustRankAdjustment(trustWeight);
}

/** An exploration pick needs measured buzz at least this high... */
export const EXPLORE_MIN_IMPORTANCE = 60;
/** ...and relevance below this: things the user wouldn't normally see. */
export const EXPLORE_MAX_RELEVANCE = 40;
/** At most this many exploration items per feed, one per five items shown. */
export const EXPLORE_MAX = 2;
/** Zero-based positions the exploration items are inserted at (4th and 9th). */
export const EXPLORE_POSITIONS = [3, 8];

export interface AlsoOn {
  source: { id: string; name: string; type: string };
  url: string;
  /** The thread on that source, when it has one. */
  discussionUrl: string | null;
  metrics: { points?: number; comments?: number };
}

/** Extra importance points per additional source carrying the same story, and the most they can add. */
export const PRESENCE_POINTS = 10;
export const MAX_PRESENCE_POINTS = 30;

export interface ClusterMember {
  sourceId: string;
  sourceType: string;
  rawMetrics: string;
}

/**
 * Importance of a story seen on several sources: the best measured buzz among
 * them, plus 10 points for each extra source (at most 30). A story on two or more
 * sources counts as measured even when none of them report engagement, since
 * being picked up by several communities is itself evidence; a story on one
 * source with no engagement stays null. Returns null when nothing measured exists.
 */
export function clusterImportance(members: ClusterMember[]): number | null {
  const distinct = new Set(members.map((m) => m.sourceId)).size;
  const measured = members.filter((m) => hasEngagementData(m.rawMetrics)).map((m) => computeImportance(m.sourceType, m.rawMetrics).score);
  const bonus = Math.min(MAX_PRESENCE_POINTS, PRESENCE_POINTS * Math.max(0, distinct - 1));
  if (measured.length > 0) return Math.min(100, Math.max(...measured) + bonus);
  return distinct >= 2 ? Math.min(100, BASELINE_IMPORTANCE + bonus) : null;
}

export interface FeedItem {
  id: string;
  title: string;
  url: string;
  discussionUrl: string | null;
  author: string | null;
  postedAt: string | null;
  source: { id: string; name: string; type: string; origin: string; /** From the user's feedback on this source; 1 is neutral. */ trustWeight: number };
  summary: { text: string; citationCount: number; articleUnreadable: boolean };
  relevance: number;
  /** 0-100 buzz from real engagement numbers, or null when the source reported none (only a baseline exists). */
  importance: number | null;
  reason: string;
  metrics: { points?: number; comments?: number };
  feedback: FeedbackState;
  /** The same story on other enabled sources, best-engaged first. Empty for a story seen on one source. */
  alsoOn: AlsoOn[];
  /** An exploration pick: high buzz, low relevance, placed to keep the feed from becoming a bubble. */
  exploration: boolean;
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
 * sources, best first. Skipped items are left out (the "saved" view shows saved ones). Items still being processed are counted in `progress`
 * instead of being shown half-finished.
 */
export async function listFeed(args: {
  ownerEmail: string;
  limit: number;
  sourceId?: string;
  /** "feed" (default) hides skipped items; "saved" lists only saved items. */
  view?: "feed" | "saved";
  /** "ranked" (default) is the blended score; "newest" is purely by date, newest first. */
  sort?: "ranked" | "newest";
  /** Leave out items the user has opened. Applied before `limit`, so the page fills with unread items. */
  hideRead?: boolean;
  now?: number;
}): Promise<{ items: FeedItem[]; progress: FeedProgress; readCount: number }> {
  const { ownerEmail, limit, sourceId, view = "feed", sort = "ranked", hideRead = false, now = Date.now() } = args;
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
    .where(and(eq(items.ownerEmail, ownerEmail), not(isRedundantMember()), ...(sourceId ? [eq(items.sourceId, sourceId)] : [])))
    .orderBy(desc(items.createdAt))
    .limit(CANDIDATE_POOL);

  const clusterOf = await loadClusters(ownerEmail, rows.map((r) => r.item.id));
  const states = await getFeedbackStates(ownerEmail, rows.map((r) => r.item.id));
  const stateOf = (id: string) => states.get(id) ?? EMPTY_FEEDBACK;

  const entries = rows
    .filter((r) => (view === "saved" ? stateOf(r.item.id).saved : !stateOf(r.item.id).skipped))
    .map((r) => {
      const cluster = clusterOf.get(r.item.id);
      const importance = cluster
        ? clusterImportance(cluster.members)
        : hasEngagementData(r.item.rawMetrics)
          ? r.score.importance
          : null;
      const item: FeedItem = {
        id: r.item.id,
        title: r.item.title,
        url: r.item.url,
        discussionUrl: r.item.discussionUrl,
        author: r.item.author,
        postedAt: r.item.postedAt,
        source: { id: r.source.id, name: r.source.name, type: r.source.type, origin: r.source.origin, trustWeight: r.source.trustWeight },
        summary: { text: r.summary.summaryText, citationCount: citationCount(r.summary.citations), articleUnreadable: r.summary.inputHash === null },
        relevance: r.score.relevance,
        importance,
        reason: r.score.reason,
        metrics: readMetrics(r.item.rawMetrics),
        feedback: stateOf(r.item.id),
        alsoOn: cluster?.alsoOn ?? [],
        exploration: false,
      };
      return {
        item,
        rank: rankScore(r.score.relevance, importance ?? r.score.importance, recencyFactor(r.item.postedAt ?? r.item.createdAt, now), r.source.trustWeight),
        when: parseTimestamp(r.item.postedAt) ?? parseTimestamp(r.item.createdAt) ?? 0,
      };
    })
    .sort(sort === "newest" ? (a, b) => b.when - a.when || b.rank - a.rank : (a, b) => b.rank - a.rank);

  const all = entries.map((e) => e.item);
  const readCount = all.filter((i) => i.feedback.opened).length;
  const visible = hideRead ? all.filter((i) => !i.feedback.opened) : all;

  return {
    // Exploration slots only make sense in the ranked main feed; a saved view is exactly what was saved,
    // and a date-ordered list shouldn't have items moved out of date order.
    items: view === "feed" && sort === "ranked" ? applyExploration(visible, limit) : visible.slice(0, limit),
    readCount,
    progress: await feedProgress(ownerEmail),
  };
}

interface ClusterInfo {
  members: ClusterMember[];
  alsoOn: AlsoOn[];
}

/**
 * For each of the given items that is the canonical item of a cluster, the
 * cluster's members: all of them (for importance) and the ones on other enabled
 * sources (for the "also on" list, deduplicated by source, best engagement first).
 */
async function loadClusters(ownerEmail: string, itemIds: string[]): Promise<Map<string, ClusterInfo>> {
  const db = getDb();
  const out = new Map<string, ClusterInfo>();
  for (let i = 0; i < itemIds.length; i += 100) {
    const canonical = await db
      .select({ id: clusters.id, canonicalItemId: clusters.canonicalItemId })
      .from(clusters)
      .where(and(eq(clusters.ownerEmail, ownerEmail), inArray(clusters.canonicalItemId, itemIds.slice(i, i + 100))));
    if (canonical.length === 0) continue;
    const members = await db
      .select({ clusterId: clusterItems.clusterId, item: items, source: sources })
      .from(clusterItems)
      .innerJoin(items, and(eq(items.id, clusterItems.itemId), eq(items.ownerEmail, ownerEmail)))
      .innerJoin(sources, and(eq(sources.id, items.sourceId), eq(sources.ownerEmail, ownerEmail), eq(sources.enabled, true)))
      .where(and(eq(clusterItems.ownerEmail, ownerEmail), inArray(clusterItems.clusterId, canonical.map((c) => c.id))));

    for (const c of canonical) {
      const rows = members.filter((m) => m.clusterId === c.id);
      const own = rows.find((m) => m.item.id === c.canonicalItemId);
      const bySource = new Map<string, AlsoOn & { points: number }>();
      for (const m of rows) {
        if (m.item.id === c.canonicalItemId || m.source.id === own?.source.id) continue;
        const metrics = readMetrics(m.item.rawMetrics);
        const prior = bySource.get(m.source.id);
        const points = metrics.points ?? 0;
        if (!prior || points > prior.points) {
          bySource.set(m.source.id, { source: { id: m.source.id, name: m.source.name, type: m.source.type }, url: m.item.url, discussionUrl: m.item.discussionUrl, metrics, points });
        }
      }
      out.set(c.canonicalItemId, {
        members: rows.map((m) => ({ sourceId: m.source.id, sourceType: m.source.type, rawMetrics: m.item.rawMetrics })),
        alsoOn: [...bySource.values()].sort((a, b) => b.points - a.points).map(({ points: _points, ...rest }) => rest),
      });
    }
  }
  return out;
}

/**
 * Reserve a couple of feed positions for items outside the user's usual interests
 * (principle 6: avoid the bubble).
 *
 * Candidates are items with *measured* importance of at least 60 and relevance
 * under 40; plain-feed items with only a baseline importance never qualify, so
 * nothing is promoted on a number we made up. The most important candidates are
 * moved to the 4th and 9th positions (one slot per five items shown, at most two)
 * and tagged `exploration`. With no candidates, or fewer than five items, the
 * list is returned unchanged. Input must already be ranked best first; the result
 * has at most `limit` items.
 */
export function applyExploration(ranked: FeedItem[], limit: number): FeedItem[] {
  const slots = Math.min(EXPLORE_MAX, Math.floor(Math.min(limit, ranked.length) / 5));
  const candidates = ranked
    .filter((i) => i.importance !== null && i.importance >= EXPLORE_MIN_IMPORTANCE && i.relevance < EXPLORE_MAX_RELEVANCE)
    .sort((a, b) => (b.importance ?? 0) - (a.importance ?? 0)); // stable: ties keep rank order
  const picks = candidates.slice(0, slots);
  if (picks.length === 0) return ranked.slice(0, limit);

  const picked = new Set(picks.map((p) => p.id));
  const result = ranked.filter((i) => !picked.has(i.id)).slice(0, limit - picks.length);
  picks.forEach((pick, index) => {
    result.splice(Math.min(EXPLORE_POSITIONS[index], result.length), 0, { ...pick, exploration: true });
  });
  return result;
}

/** How much of the pipeline is still pending, for items from enabled sources. */
export async function feedProgress(ownerEmail: string): Promise<FeedProgress> {
  const db = getDb();
  const enabled = and(eq(items.ownerEmail, ownerEmail), eq(sources.enabled, true), not(isRedundantMember()));
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

export { parseTimestamp };
