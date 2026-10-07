import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const dir = mkdtempSync(join(tmpdir(), "observer-feed-"));
process.env.DATABASE_URL = `pglite:${join(dir, "db")}`;

const { runMigrations, closeDbExec } = await import("@agent-native/core/db");
const { APP_MIGRATIONS, APP_MIGRATIONS_TABLE } = await import("../../db/migrations.js");
const { getDb, schema } = await import("../../db/index.js");
const { feedProgress, listFeed, parseTimestamp, rankScore, recencyFactor } = await import("../feed.js");
const { eq } = await import("drizzle-orm");

const NOW = Date.parse("2026-10-07T12:00:00.000Z");
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();

describe("ranking helpers", () => {
  it("parses ISO and Postgres now() timestamps, and rejects junk", () => {
    expect(parseTimestamp("2026-10-07T12:00:00.000Z")).toBe(NOW);
    expect(parseTimestamp("2026-10-07 04:00:00.5-08")).toBe(Date.parse("2026-10-07T12:00:00.500Z"));
    expect(parseTimestamp("2026-10-07 12:00:00+00")).toBe(NOW);
    expect(parseTimestamp("garbage")).toBeNull();
    expect(parseTimestamp(null)).toBeNull();
  });

  it("halves recency every 24 hours, and treats unknown age as a day old", () => {
    expect(recencyFactor(hoursAgo(0), NOW)).toBe(1);
    expect(recencyFactor(hoursAgo(24), NOW)).toBeCloseTo(0.5);
    expect(recencyFactor(hoursAgo(48), NOW)).toBeCloseTo(0.25);
    expect(recencyFactor("garbage", NOW)).toBeCloseTo(0.5);
    expect(recencyFactor(new Date(NOW + 3_600_000).toISOString(), NOW)).toBe(1); // future dates don't exceed 1
  });

  it("weights relevance most, then importance and recency equally", () => {
    expect(rankScore(100, 0, 0)).toBe(60);
    expect(rankScore(0, 100, 0)).toBe(20);
    expect(rankScore(0, 0, 1)).toBe(20);
    expect(rankScore(80, 10, 0.5)).toBeGreaterThan(rankScore(50, 90, 0.5)); // relevance beats buzz
    expect(rankScore(50, 100, 0.5)).toBeGreaterThan(rankScore(70, 0, 0.5)); // but enough buzz can outweigh a modest relevance gap
  });
});

const ALICE = "alice@example.com";
const BOB = "bob@example.com";

async function addSource(owner = ALICE, over: Partial<typeof schema.sources.$inferInsert> = {}) {
  const id = crypto.randomUUID();
  await getDb().insert(schema.sources).values({ id, ownerEmail: owner, type: "rss", connector: "feed", name: "Feed", ...over });
  return id;
}
async function addItem(sourceId: string, opts: { owner?: string; status?: string; summary?: boolean; relevance?: number; importance?: number; postedAt?: string; title?: string; metrics?: object } = {}) {
  const owner = opts.owner ?? ALICE;
  const id = crypto.randomUUID();
  await getDb().insert(schema.items).values({
    id, ownerEmail: owner, sourceId, externalId: id, url: `https://x.example.com/${id}`, title: opts.title ?? id.slice(0, 6),
    fetchStatus: opts.status ?? "ok", postedAt: opts.postedAt ?? hoursAgo(1), rawMetrics: JSON.stringify(opts.metrics ?? {}),
  });
  if (opts.summary !== false) {
    await getDb().insert(schema.summaries).values({ id: crypto.randomUUID(), ownerEmail: owner, itemId: id, summaryText: "Summary text.", citations: JSON.stringify([{ quote: "a" }, { quote: "b" }]), inputHash: opts.status === "failed" ? null : "h" });
  }
  if (opts.relevance !== undefined) {
    await getDb().insert(schema.scores).values({ id: crypto.randomUUID(), ownerEmail: owner, itemId: id, relevance: opts.relevance, importance: opts.importance ?? 0, reason: "Because." });
  }
  return id;
}

beforeAll(async () => {
  await runMigrations(APP_MIGRATIONS, { table: APP_MIGRATIONS_TABLE })(null);
});
afterAll(async () => {
  await closeDbExec();
  rmSync(dir, { recursive: true, force: true });
});

describe("listFeed", () => {
  it("ranks by the blended score, includes everything the UI must show, and respects the limit", async () => {
    const owner = "rank@example.com";
    const src = await addSource(owner, { name: "HN", type: "hn", connector: "api" });
    const best = await addItem(src, { owner, relevance: 90, importance: 50, postedAt: hoursAgo(2), metrics: { points: 120, comments: 40 }, title: "Best" });
    const buzzy = await addItem(src, { owner, relevance: 10, importance: 100, postedAt: hoursAgo(2), title: "Buzzy but irrelevant" });
    const stale = await addItem(src, { owner, relevance: 90, importance: 50, postedAt: hoursAgo(24 * 10), title: "Old" });

    const { items } = await listFeed({ ownerEmail: owner, limit: 10, now: NOW });
    // A 10-day-old but highly relevant item still outranks a fresh, irrelevant, buzzy one.
    expect(items.map((i) => i.title)).toEqual(["Best", "Old", "Buzzy but irrelevant"]);
    expect(items[0]).toMatchObject({
      id: best, relevance: 90, importance: 50, reason: "Because.", metrics: { points: 120, comments: 40 },
      source: { name: "HN", type: "hn", origin: "user" }, summary: { text: "Summary text.", citationCount: 2, articleUnreadable: false },
    });
    expect(items.find((i) => i.id === stale)).toBeDefined();
    expect(items.find((i) => i.id === buzzy)).toBeDefined();
    expect((await listFeed({ ownerEmail: owner, limit: 1, now: NOW })).items).toHaveLength(1);
  });

  it("flags summaries of unreadable articles", async () => {
    const owner = "unreadable@example.com";
    const src = await addSource(owner);
    await addItem(src, { owner, status: "failed", relevance: 30 });
    expect((await listFeed({ ownerEmail: owner, limit: 5, now: NOW })).items[0].summary.articleUnreadable).toBe(true);
  });

  it("hides unscored items, disabled sources, other users' items, and can filter by source", async () => {
    const owner = "hide@example.com";
    const live = await addSource(owner, { name: "Live" });
    const off = await addSource(owner, { name: "Off", enabled: false });
    const other = await addSource(owner, { name: "Other" });
    const shown = await addItem(live, { owner, relevance: 50 });
    await addItem(live, { owner, summary: true }); // summarized, not scored
    await addItem(off, { owner, relevance: 99 });
    const onOther = await addItem(other, { owner, relevance: 40 });
    const bobSrc = await addSource(BOB);
    await addItem(bobSrc, { owner: BOB, relevance: 99 });

    expect((await listFeed({ ownerEmail: owner, limit: 10, now: NOW })).items.map((i) => i.id).sort()).toEqual([shown, onOther].sort());
    expect((await listFeed({ ownerEmail: owner, limit: 10, sourceId: other, now: NOW })).items.map((i) => i.id)).toEqual([onOther]);
    expect((await listFeed({ ownerEmail: "nobody@example.com", limit: 10, now: NOW })).items).toEqual([]);
  });
});

describe("feedProgress", () => {
  it("counts where items are stuck in the pipeline, for enabled sources only", async () => {
    const owner = "progress@example.com";
    const src = await addSource(owner);
    const off = await addSource(owner, { enabled: false });
    await addItem(src, { owner, status: "pending", summary: false }); // needs article
    await addItem(src, { owner, status: "ok", summary: false }); // needs summary
    await addItem(src, { owner, status: "failed", summary: false }); // needs (unavailable) summary
    await addItem(src, { owner, summary: true }); // needs score
    await addItem(src, { owner, relevance: 70 }); // ready
    await addItem(off, { owner, status: "pending", summary: false }); // ignored: source disabled

    expect(await feedProgress(owner)).toEqual({ sources: 1, needArticle: 1, needSummary: 2, needScore: 1, ready: 1 });
    expect(await feedProgress("empty@example.com")).toEqual({ sources: 0, needArticle: 0, needSummary: 0, needScore: 0, ready: 0 });
  });

  it("moves an item along as work completes", async () => {
    const owner = "moves@example.com";
    const src = await addSource(owner);
    const id = await addItem(src, { owner, summary: true });
    expect((await feedProgress(owner)).needScore).toBe(1);
    await getDb().insert(schema.scores).values({ id: crypto.randomUUID(), ownerEmail: owner, itemId: id, relevance: 60, importance: 5, reason: "r" });
    expect(await feedProgress(owner)).toMatchObject({ needScore: 0, ready: 1 });
    await getDb().update(schema.sources).set({ enabled: false }).where(eq(schema.sources.id, src));
    expect(await feedProgress(owner)).toMatchObject({ sources: 0, ready: 0 });
  });
});
