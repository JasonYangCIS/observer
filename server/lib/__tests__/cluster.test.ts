import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const dir = mkdtempSync(join(tmpdir(), "observer-cluster-"));
process.env.DATABASE_URL = `pglite:${join(dir, "db")}`;

const { runMigrations, closeDbExec } = await import("@agent-native/core/db");
const { APP_MIGRATIONS, APP_MIGRATIONS_TABLE } = await import("../../db/migrations.js");
const { getDb, schema } = await import("../../db/index.js");
const { runClustering, urlKey } = await import("../cluster.js");
const { clusterImportance, feedProgress, listFeed } = await import("../feed.js");
const { fetchPendingArticles } = await import("../article-text.js");
const { listPendingSummaries } = await import("../summaries.js");
const { listPendingScores } = await import("../scores.js");
const { ingestSource } = await import("../ingest.js");
const { removeSource } = await import("../sources.js");
const { eq } = await import("drizzle-orm");

const NOW = Date.parse("2026-10-07T12:00:00.000Z");
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();

describe("urlKey", () => {
  it("treats links to the same article as equal", () => {
    const same = [
      "https://refactoringenglish.com/blog/anti-patterns/",
      "http://www.refactoringenglish.com/blog/anti-patterns",
      "https://REFACTORINGENGLISH.com:443/blog/anti-patterns#comments",
      "https://refactoringenglish.com//blog//anti-patterns?utm_source=hn&utm_medium=x&fbclid=abc&ref=newsletter",
    ];
    expect(new Set(same.map((u) => urlKey(u))).size).toBe(1);
    expect(urlKey(same[0])).toBe("refactoringenglish.com/blog/anti-patterns");
  });

  it("keeps real query parameters (sorted) and distinguishes different pages", () => {
    expect(urlKey("https://a.example.com/watch?v=2&t=5")).toBe(urlKey("https://a.example.com/watch?t=5&v=2"));
    expect(urlKey("https://a.example.com/watch?v=1")).not.toBe(urlKey("https://a.example.com/watch?v=2"));
    expect(urlKey("https://a.example.com/a")).not.toBe(urlKey("https://a.example.com/b"));
    expect(urlKey("https://a.example.com/")).toBe("a.example.com/");
    expect(urlKey("https://a.example.com/x")).not.toBe(urlKey("https://b.example.com/x"));
  });

  it("returns null for anything that isn't an http(s) URL", () => {
    for (const bad of ["javascript:alert(1)", "data:text/html,x", "file:///etc/passwd", "not a url", ""]) expect(urlKey(bad)).toBeNull();
  });
});

describe("clusterImportance", () => {
  const m = (sourceId: string, raw: object, sourceType = "hn") => ({ sourceId, sourceType, rawMetrics: JSON.stringify(raw) });

  it("takes the best measured buzz and adds 10 points per extra source, up to 30", () => {
    const single = clusterImportance([m("hn", { points: 100, comments: 20 })])!;
    expect(clusterImportance([m("hn", { points: 100, comments: 20 }), m("lob", { points: 10, comments: 1 }, "lobsters")])).toBe(single + 10);
    const crowd = [m("a", { points: 100, comments: 20 }), m("b", {}), m("c", {}), m("d", {}), m("e", {})];
    expect(clusterImportance(crowd)).toBe(single + 30); // four extra sources, capped at 30
    expect(clusterImportance([m("a", { points: 50000, comments: 20000 }), m("b", {})])).toBe(100); // never above 100
  });

  it("counts a story on several sources as measured even without engagement numbers, but not a lone one", () => {
    expect(clusterImportance([m("a", {}, "rss")])).toBeNull();
    expect(clusterImportance([m("a", {}, "rss"), m("a", {}, "rss")])).toBeNull(); // the same source twice is still one source
    expect(clusterImportance([m("a", {}, "rss"), m("b", {}, "reddit")])).toBe(30); // baseline 20 + 10
  });
});

const ALICE = "alice@example.com";
const BOB = "bob@example.com";

async function addSource(owner = ALICE, over: Partial<typeof schema.sources.$inferInsert> = {}) {
  const id = crypto.randomUUID();
  await getDb().insert(schema.sources).values({ id, ownerEmail: owner, type: "rss", connector: "feed", name: "Feed", ...over });
  return id;
}
async function addItem(sourceId: string, url: string, opts: { owner?: string; title?: string; postedAt?: string; discussionUrl?: string; metrics?: object; processed?: boolean; createdAt?: string } = {}) {
  const owner = opts.owner ?? ALICE;
  const id = crypto.randomUUID();
  await getDb().insert(schema.items).values({
    id, ownerEmail: owner, sourceId, externalId: id, url, title: opts.title ?? "Title", postedAt: opts.postedAt ?? hoursAgo(5),
    discussionUrl: opts.discussionUrl, rawMetrics: JSON.stringify(opts.metrics ?? {}), ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
  });
  if (opts.processed) {
    await getDb().insert(schema.summaries).values({ id: crypto.randomUUID(), ownerEmail: owner, itemId: id, summaryText: "Summary.", inputHash: "h" });
    await getDb().insert(schema.scores).values({ id: crypto.randomUUID(), ownerEmail: owner, itemId: id, relevance: 60, importance: 20, reason: "r" });
  }
  return id;
}
const clusterRows = (owner: string) => getDb().select().from(schema.clusters).where(eq(schema.clusters.ownerEmail, owner));
const memberRows = (owner: string) => getDb().select().from(schema.clusterItems).where(eq(schema.clusterItems.ownerEmail, owner));

beforeAll(async () => {
  await runMigrations(APP_MIGRATIONS, { table: APP_MIGRATIONS_TABLE })(null);
});
afterAll(async () => {
  await closeDbExec();
  rmSync(dir, { recursive: true, force: true });
});

describe("runClustering", () => {
  it("groups the same article across sources, leaves singletons alone, and is idempotent", async () => {
    const owner = "group@example.com";
    const hn = await addSource(owner, { type: "hn", name: "HN" });
    const lob = await addSource(owner, { type: "lobsters", name: "Lobsters" });
    const a1 = await addItem(hn, "https://blog.example.com/post", { owner, postedAt: hoursAgo(5), title: "Original" });
    const a2 = await addItem(lob, "https://www.blog.example.com/post/?utm_source=lobsters", { owner, postedAt: hoursAgo(3) });
    const solo = await addItem(hn, "https://other.example.com/solo", { owner });

    expect(await runClustering(owner, null)).toEqual({ clustersCreated: 1, itemsAdded: 2, clusteredItems: 2 });
    const [cluster] = await clusterRows(owner);
    expect(cluster).toMatchObject({ urlKey: "blog.example.com/post", canonicalItemId: a1, topicLabel: "Original" }); // earliest posted
    expect((await memberRows(owner)).map((m) => m.itemId).sort()).toEqual([a1, a2].sort());
    expect((await memberRows(owner)).some((m) => m.itemId === solo)).toBe(false);

    expect(await runClustering(owner, null)).toEqual({ clustersCreated: 0, itemsAdded: 0, clusteredItems: 0 });
    expect(await clusterRows(owner)).toHaveLength(1);
  });

  it("adds later items to an existing cluster and keeps its canonical item", async () => {
    const owner = "incremental@example.com";
    const hn = await addSource(owner, { type: "hn" });
    const lob = await addSource(owner, { type: "lobsters" });
    const red = await addSource(owner, { type: "reddit" });
    const first = await addItem(hn, "https://blog.example.com/x", { owner, postedAt: hoursAgo(10) });
    await addItem(lob, "https://blog.example.com/x", { owner, postedAt: hoursAgo(9) });
    await runClustering(owner, null);
    const early = await addItem(red, "https://blog.example.com/x?utm_campaign=z", { owner, postedAt: hoursAgo(20) }); // posted earlier than everything

    expect(await runClustering(owner, null)).toMatchObject({ clustersCreated: 0, itemsAdded: 1 });
    const [cluster] = await clusterRows(owner);
    expect(cluster.canonicalItemId).toBe(first); // not stolen by the earlier-dated newcomer
    expect((await memberRows(owner)).map((m) => m.itemId)).toContain(early);
  });

  it("prefers a member that was already summarized and scored as the canonical item", async () => {
    const owner = "processed@example.com";
    const hn = await addSource(owner, { type: "hn" });
    const lob = await addSource(owner, { type: "lobsters" });
    await addItem(hn, "https://blog.example.com/y", { owner, postedAt: hoursAgo(10) });
    const done = await addItem(lob, "https://blog.example.com/y", { owner, postedAt: hoursAgo(2), processed: true });
    await runClustering(owner, null);
    expect((await clusterRows(owner))[0].canonicalItemId).toBe(done);
  });

  it("never clusters discussion-only posts, old items, or other users' items together", async () => {
    const owner = "edge@example.com";
    const hn = await addSource(owner, { type: "hn" });
    const lob = await addSource(owner, { type: "lobsters" });
    const thread = "https://news.ycombinator.com/item?id=1";
    await addItem(hn, thread, { owner, discussionUrl: thread });
    await addItem(lob, thread, { owner, discussionUrl: thread });
    await addItem(hn, "https://blog.example.com/old", { owner, createdAt: "2025-01-01T00:00:00.000Z" });
    await addItem(lob, "https://blog.example.com/old", { owner, createdAt: "2025-01-01T00:00:00.000Z" });
    expect(await runClustering(owner, null)).toEqual({ clustersCreated: 0, itemsAdded: 0, clusteredItems: 0 });

    const aHn = await addSource(ALICE, { type: "hn" });
    const bHn = await addSource(BOB, { type: "hn" });
    await addItem(aHn, "https://shared.example.com/p", { owner: ALICE });
    await addItem(bHn, "https://shared.example.com/p", { owner: BOB });
    expect((await runClustering(ALICE, null)).clustersCreated).toBe(0);
    expect((await runClustering(BOB, null)).clustersCreated).toBe(0);
  });
});

describe("redundant members stay out of the expensive steps", () => {
  it("fetches, summarizes, and scores only the canonical item, and reports progress accordingly", async () => {
    const owner = "pipeline@example.com";
    const hn = await addSource(owner, { type: "hn" });
    const lob = await addSource(owner, { type: "lobsters" });
    const canonical = await addItem(hn, "https://blog.example.com/z", { owner, postedAt: hoursAgo(10) });
    const redundant = await addItem(lob, "https://blog.example.com/z", { owner, postedAt: hoursAgo(9) });
    await runClustering(owner, null);

    const fetched: string[] = [];
    const results = await fetchPendingArticles({ ownerEmail: owner, limit: 10, fetchText: async (url) => (fetched.push(url), { text: "<html><body><p>x</p></body></html>", status: 200, contentType: "text/html", finalUrl: url }) });
    expect(results.map((r) => r.itemId)).toEqual([canonical]);
    expect(fetched).toHaveLength(1);

    // Pretend the article was read so it is eligible for the later steps.
    await getDb().update(schema.items).set({ fetchStatus: "ok", fetchedText: "text" }).where(eq(schema.items.id, redundant));
    await getDb().update(schema.items).set({ fetchStatus: "ok", fetchedText: "text" }).where(eq(schema.items.id, canonical));
    expect((await listPendingSummaries(owner, 25)).map((p) => p.id)).toEqual([canonical]);
    await getDb().insert(schema.summaries).values([canonical, redundant].map((id) => ({ id: crypto.randomUUID(), ownerEmail: owner, itemId: id, summaryText: "S.", inputHash: "h" })));
    expect((await listPendingScores(owner, 25)).map((p) => p.id)).toEqual([canonical]);
    expect(await feedProgress(owner)).toMatchObject({ needArticle: 0, needSummary: 0, needScore: 1 });
  });
});

describe("the feed shows one entry per story", () => {
  it("lists the canonical item with the other sources as 'also on', best-engaged first, and boosts importance", async () => {
    const owner = "feed@example.com";
    const hn = await addSource(owner, { type: "hn", name: "HN" });
    const lob = await addSource(owner, { type: "lobsters", name: "Lobsters" });
    const red = await addSource(owner, { type: "reddit", name: "r/programming" });
    const off = await addSource(owner, { type: "devto", name: "dev.to", enabled: false });
    const url = "https://blog.example.com/story";
    const canonical = await addItem(hn, url, { owner, postedAt: hoursAgo(10), metrics: { points: 100, comments: 20 }, processed: true, discussionUrl: "https://news.ycombinator.com/item?id=5" });
    await addItem(lob, url, { owner, postedAt: hoursAgo(9), metrics: { points: 66, comments: 31 }, discussionUrl: "https://lobste.rs/s/abc" });
    await addItem(lob, `${url}?utm_source=x`, { owner, postedAt: hoursAgo(8), metrics: { points: 5, comments: 0 } }); // same source twice: one badge
    await addItem(red, url, { owner, postedAt: hoursAgo(7), metrics: {}, discussionUrl: "https://reddit.com/r/programming/comments/1" });
    await addItem(off, url, { owner, postedAt: hoursAgo(6), metrics: { points: 999, comments: 1 } }); // disabled source: hidden
    await runClustering(owner, null);

    const { items } = await listFeed({ ownerEmail: owner, limit: 10, now: NOW });
    expect(items).toHaveLength(1);
    const entry = items[0];
    expect(entry.id).toBe(canonical);
    expect(entry.alsoOn.map((a) => [a.source.name, a.discussionUrl, a.metrics.points])).toEqual([
      ["Lobsters", "https://lobste.rs/s/abc", 66],
      ["r/programming", "https://reddit.com/r/programming/comments/1", undefined],
    ]);
    const alone = clusterImportance([{ sourceId: hn, sourceType: "hn", rawMetrics: JSON.stringify({ points: 100, comments: 20 }) }])!;
    expect(entry.importance).toBe(alone + 20); // two extra enabled sources
  });

  it("hides a processed non-canonical member instead of showing the story twice", async () => {
    const owner = "dupe-hidden@example.com";
    const hn = await addSource(owner, { type: "hn" });
    const lob = await addSource(owner, { type: "lobsters" });
    const url = "https://blog.example.com/twice";
    await addItem(hn, url, { owner, postedAt: hoursAgo(10), processed: true });
    await addItem(lob, url, { owner, postedAt: hoursAgo(9), processed: true });
    await runClustering(owner, null);
    expect((await listFeed({ ownerEmail: owner, limit: 10, now: NOW })).items).toHaveLength(1);
  });

  it("leaves unclustered items exactly as before", async () => {
    const owner = "plain@example.com";
    const hn = await addSource(owner, { type: "hn" });
    const a = await addItem(hn, "https://a.example.com/1", { owner, processed: true, metrics: { points: 10, comments: 1 } });
    const [item] = (await listFeed({ ownerEmail: owner, limit: 10, now: NOW })).items;
    expect(item).toMatchObject({ id: a, alsoOn: [], importance: 20 });
  });
});

describe("removing a source repairs clusters", () => {
  it("dissolves a cluster that drops below two members and re-picks a lost canonical item", async () => {
    const owner = "remove@example.com";
    const s1 = await addSource(owner, { type: "hn" });
    const s2 = await addSource(owner, { type: "lobsters" });
    const s3 = await addSource(owner, { type: "reddit" });
    const c1 = await addItem(s1, "https://blog.example.com/r", { owner, postedAt: hoursAgo(10) });
    const m2 = await addItem(s2, "https://blog.example.com/r", { owner, postedAt: hoursAgo(9) });
    const m3 = await addItem(s3, "https://blog.example.com/r", { owner, postedAt: hoursAgo(8) });
    await runClustering(owner, null);
    expect((await clusterRows(owner))[0].canonicalItemId).toBe(c1);

    await removeSource(owner, s1); // loses the canonical item, two members remain
    const [cluster] = await clusterRows(owner);
    expect(cluster.canonicalItemId).toBe(m2); // earliest remaining
    expect((await memberRows(owner)).map((m) => m.itemId).sort()).toEqual([m2, m3].sort());

    await removeSource(owner, s3); // one member left: nothing to cluster
    expect(await clusterRows(owner)).toHaveLength(0);
    expect(await memberRows(owner)).toHaveLength(0);
  });
});

describe("clustering during ingest", () => {
  it("groups a story as soon as the second source is fetched", async () => {
    const owner = "ingest@example.com";
    const rss1 = await addSource(owner, { name: "Blog A", config: JSON.stringify({ url: "https://a.example.com/feed" }) });
    const rss2 = await addSource(owner, { name: "Blog B", config: JSON.stringify({ url: "https://b.example.com/feed" }) });
    const feed = `<rss version="2.0"><channel><item><title>Same</title><link>https://news.example.com/story?utm_source=feed</link><guid>1</guid></item></channel></rss>`;
    const fetchText = async (url: string) => ({ text: feed, status: 200, contentType: "", finalUrl: url });
    expect((await ingestSource({ ownerEmail: owner, sourceId: rss1, fetchText })).clusteredItems).toBe(0);
    expect((await ingestSource({ ownerEmail: owner, sourceId: rss2, fetchText })).clusteredItems).toBe(2);
    expect(await clusterRows(owner)).toHaveLength(1);
  });
});
