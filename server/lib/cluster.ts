import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { getDb, schema } from "../db/index.js";

const { items, summaries, scores, clusters, clusterItems } = schema;

/** Only items from this many days back are considered when clustering. */
const CLUSTER_WINDOW_DAYS = 60;
const MAX_ITEMS_SCANNED = 5000;

// Query parameters that identify a visit, not a page.
const TRACKING_PARAMS = /^(utm_.*|fbclid|gclid|dclid|msclkid|mc_cid|mc_eid|igshid|ref|ref_src|ref_url|_hsenc|_hsmi)$/i;

/**
 * A key that is the same for two links to the same article: scheme, `www.`, port,
 * fragment, trailing slash, and tracking parameters are ignored, and the remaining
 * query parameters are sorted. Returns null for anything that isn't an http(s) URL.
 * It deliberately does not guess (no title matching, no redirect following), so two
 * different pages are never merged by mistake.
 */
export function urlKey(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  if (!host) return null;
  const path = url.pathname.replace(/\/{2,}/g, "/").replace(/(.)\/$/, "$1");
  const params = [...url.searchParams.entries()].filter(([name]) => !TRACKING_PARAMS.test(name)).sort(([a], [b]) => a.localeCompare(b));
  const query = params.length ? `?${params.map(([k, v]) => `${k}=${v}`).join("&")}` : "";
  return `${host}${path}${query}`;
}

type DbLike = Pick<ReturnType<typeof getDb>, "select" | "delete" | "update" | "insert">;

/**
 * SQL condition: this item belongs to a cluster whose canonical item is a
 * different one. Such items are shown through the canonical item, so they must
 * not be fetched, summarized, scored, or listed on their own.
 */
export function isRedundantMember() {
  return sql`exists (select 1 from cluster_items join clusters on clusters.id = cluster_items.cluster_id where cluster_items.item_id = ${items.id} and clusters.canonical_item_id <> ${items.id})`;
}

export interface ClusterResult {
  clustersCreated: number;
  itemsAdded: number;
  /** Items that share a story with another source and are now represented by a canonical item. */
  clusteredItems: number;
}

/**
 * Group the owner's items that link to the same article.
 *
 * Idempotent and incremental: new items join an existing cluster with the same
 * URL, and two or more unclustered items with the same URL form a new one.
 * Discussion-only posts (whose URL is their own thread) are never clustered. The
 * canonical item of a new cluster is one that has already been summarized and
 * scored if any has, otherwise the earliest posted, so work already done isn't
 * thrown away. Existing clusters keep their canonical item.
 */
export async function runClustering(ownerEmail: string, orgId: string | null): Promise<ClusterResult> {
  const db = getDb();
  const rows = await db
    .select({ id: items.id, title: items.title, url: items.url, discussionUrl: items.discussionUrl, postedAt: items.postedAt, createdAt: items.createdAt })
    .from(items)
    .where(and(eq(items.ownerEmail, ownerEmail), sql`${items.createdAt}::timestamptz > now() - make_interval(days => ${CLUSTER_WINDOW_DAYS})`))
    .limit(MAX_ITEMS_SCANNED);

  const keyed = rows
    .filter((r) => !(r.discussionUrl && r.url === r.discussionUrl))
    .map((r) => ({ ...r, key: urlKey(r.url) }))
    .filter((r): r is typeof r & { key: string } => r.key !== null);

  const existing = await db.select().from(clusters).where(eq(clusters.ownerEmail, ownerEmail));
  const clusterByKey = new Map(existing.map((c) => [c.urlKey, c]));
  const memberRows = await db.select({ itemId: clusterItems.itemId }).from(clusterItems).where(eq(clusterItems.ownerEmail, ownerEmail));
  const members = new Set(memberRows.map((m) => m.itemId));

  const processed = await processedItemIds(ownerEmail, keyed.map((r) => r.id));
  const byKey = new Map<string, typeof keyed>();
  for (const row of keyed) byKey.set(row.key, [...(byKey.get(row.key) ?? []), row]);

  const result: ClusterResult = { clustersCreated: 0, itemsAdded: 0, clusteredItems: 0 };
  for (const [key, group] of byKey) {
    const unclustered = group.filter((r) => !members.has(r.id));
    if (unclustered.length === 0) continue;
    const when = (r: (typeof keyed)[number]) => new Date(r.postedAt ?? r.createdAt.replace(" ", "T")).getTime() || 0;
    const cluster = clusterByKey.get(key);

    if (cluster) {
      await db.insert(clusterItems).values(unclustered.map((r) => ({ id: randomUUID(), ownerEmail, orgId, clusterId: cluster.id, itemId: r.id })));
      result.itemsAdded += unclustered.length;
      result.clusteredItems += unclustered.length;
    } else if (unclustered.length >= 2) {
      const canonical = [...unclustered].sort((a, b) => Number(processed.has(b.id)) - Number(processed.has(a.id)) || when(a) - when(b))[0];
      const id = randomUUID();
      await db.insert(clusters).values({ id, ownerEmail, orgId, urlKey: key, canonicalItemId: canonical.id, topicLabel: canonical.title.slice(0, 300) });
      await db.insert(clusterItems).values(unclustered.map((r) => ({ id: randomUUID(), ownerEmail, orgId, clusterId: id, itemId: r.id })));
      result.clustersCreated++;
      result.itemsAdded += unclustered.length;
      result.clusteredItems += unclustered.length;
    }
  }
  return result;
}

/** Of the given items, those that already have both a summary and a score. */
async function processedItemIds(ownerEmail: string, itemIds: string[]): Promise<Set<string>> {
  const done = new Set<string>();
  for (let i = 0; i < itemIds.length; i += 200) {
    const chunk = itemIds.slice(i, i + 200);
    const rows = await getDb()
      .select({ id: summaries.itemId })
      .from(summaries)
      .innerJoin(scores, and(eq(scores.itemId, summaries.itemId), eq(scores.ownerEmail, ownerEmail)))
      .where(and(eq(summaries.ownerEmail, ownerEmail), inArray(summaries.itemId, chunk)));
    for (const r of rows) done.add(r.id);
  }
  return done;
}

/**
 * Take items out of their clusters (they are being deleted). A cluster left with
 * fewer than two members is dissolved; one that lost its canonical item picks the
 * earliest remaining member. Call inside the same transaction that deletes the items.
 */
export async function detachItems(db: DbLike, ownerEmail: string, itemIds: string[]): Promise<void> {
  if (itemIds.length === 0) return;
  const affected = new Set<string>();
  for (let i = 0; i < itemIds.length; i += 100) {
    const chunk = itemIds.slice(i, i + 100);
    const rows = await db.select({ clusterId: clusterItems.clusterId }).from(clusterItems).where(and(eq(clusterItems.ownerEmail, ownerEmail), inArray(clusterItems.itemId, chunk)));
    for (const r of rows) affected.add(r.clusterId);
    await db.delete(clusterItems).where(and(eq(clusterItems.ownerEmail, ownerEmail), inArray(clusterItems.itemId, chunk)));
  }
  const removed = new Set(itemIds);
  for (const clusterId of affected) {
    const remaining = await db
      .select({ itemId: clusterItems.itemId, postedAt: items.postedAt, createdAt: items.createdAt })
      .from(clusterItems)
      .innerJoin(items, eq(items.id, clusterItems.itemId))
      .where(and(eq(clusterItems.ownerEmail, ownerEmail), eq(clusterItems.clusterId, clusterId)));
    if (remaining.length < 2) {
      await db.delete(clusterItems).where(and(eq(clusterItems.ownerEmail, ownerEmail), eq(clusterItems.clusterId, clusterId)));
      await db.delete(clusters).where(and(eq(clusters.ownerEmail, ownerEmail), eq(clusters.id, clusterId)));
      continue;
    }
    const [cluster] = await db.select().from(clusters).where(and(eq(clusters.ownerEmail, ownerEmail), eq(clusters.id, clusterId)));
    if (cluster && removed.has(cluster.canonicalItemId)) {
      const when = (r: (typeof remaining)[number]) => new Date(r.postedAt ?? r.createdAt.replace(" ", "T")).getTime() || 0;
      const next = [...remaining].sort((a, b) => when(a) - when(b))[0];
      await db.update(clusters).set({ canonicalItemId: next.itemId }).where(eq(clusters.id, clusterId));
    }
  }
}
