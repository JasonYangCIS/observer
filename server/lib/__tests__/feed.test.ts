import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const dir = mkdtempSync(join(tmpdir(), "observer-feed-"));
process.env.DATABASE_URL = `pglite:${join(dir, "db")}`;

const { runMigrations, closeDbExec } = await import("@agent-native/core/db");
const { APP_MIGRATIONS, APP_MIGRATIONS_TABLE } = await import("../../db/migrations.js");
const { getDb, schema } = await import("../../db/index.js");
const { EXPLORE_MAX, EXPLORE_MAX_RELEVANCE, EXPLORE_MIN_IMPORTANCE, applyExploration, feedProgress, listFeed, parseTimestamp, rankScore, recencyFactor } = await import("../feed.js");
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

type TestFeedItem = Parameters<typeof applyExploration>[0][number];
function fake(id: string, relevance: number, importance: number | null): TestFeedItem {
  return {
    id, title: id, url: `https://x.example.com/${id}`, discussionUrl: null, author: null, postedAt: null,
    source: { id: "s", name: "S", type: "hn", origin: "user", trustWeight: 1 }, summary: { text: "s", citationCount: 1, articleUnreadable: false },
    relevance, importance, reason: "r", metrics: {}, feedback: { liked: false, skipped: false, saved: false, opened: false }, exploration: false,
  };
}
/** 12 ranked items: relevant ones first, then two high-buzz low-relevance candidates near the bottom. */
function ranked() {
  return [
    ...Array.from({ length: 8 }, (_, i) => fake(`rel${i}`, 90 - i, 30)),
    fake("buzz-mid", 20, 70),
    fake("quiet", 10, 20),
    fake("buzz-top", 5, 95),
    fake("baseline", 5, null),
  ];
}

describe("applyExploration", () => {
  it("moves the most important high-buzz, low-relevance items to the 4th and 9th positions and tags them", () => {
    const out = applyExploration(ranked(), 30);
    expect(out).toHaveLength(12);
    expect(out[3]).toMatchObject({ id: "buzz-top", exploration: true });
    expect(out[8]).toMatchObject({ id: "buzz-mid", exploration: true });
    expect(out.filter((i) => i.exploration).map((i) => i.id)).toEqual(["buzz-top", "buzz-mid"]);
    expect(new Set(out.map((i) => i.id)).size).toBe(12); // nobody duplicated or lost
    expect(out.slice(0, 3).map((i) => i.id)).toEqual(["rel0", "rel1", "rel2"]); // the top stays relevance-ranked
  });

  it("never promotes an item whose importance is only a baseline, or that isn't clearly irrelevant, or isn't clearly buzzy", () => {
    const out = applyExploration([...Array.from({ length: 6 }, (_, i) => fake(`r${i}`, 90, 30)), fake("baseline", 1, null), fake("meh", 39, EXPLORE_MIN_IMPORTANCE - 1), fake("edge-rel", EXPLORE_MAX_RELEVANCE, 99)], 30);
    expect(out.some((i) => i.exploration)).toBe(false);
    expect(EXPLORE_MAX).toBe(2);
  });

  it("returns the list unchanged when nothing qualifies, and shows no slots in a very short feed", () => {
    const plain = Array.from({ length: 10 }, (_, i) => fake(`p${i}`, 80 - i, 30));
    expect(applyExploration(plain, 30).map((i) => i.id)).toEqual(plain.map((i) => i.id));
    const short = [fake("a", 90, 30), fake("b", 80, 30), fake("c", 5, 99)];
    expect(applyExploration(short, 30).some((i) => i.exploration)).toBe(false); // fewer than five items
  });

  it("scales slots with the list: one for five to nine items, two for ten or more", () => {
    const five = [...Array.from({ length: 4 }, (_, i) => fake(`r${i}`, 90 - i, 30)), fake("b1", 5, 90)];
    expect(applyExploration(five, 30).filter((i) => i.exploration)).toHaveLength(1);
    expect(applyExploration(five, 30)[3].id).toBe("b1");
    const ten = [...Array.from({ length: 8 }, (_, i) => fake(`r${i}`, 90 - i, 30)), fake("b1", 5, 90), fake("b2", 6, 80), fake("b3", 7, 70)];
    expect(applyExploration(ten, 30).filter((i) => i.exploration).map((i) => i.id)).toEqual(["b1", "b2"]);
  });

  it("respects the limit, including the exploration items, and keeps ties in rank order", () => {
    const list = applyExploration(ranked(), 10);
    expect(list).toHaveLength(10);
    expect(list.filter((i) => i.exploration)).toHaveLength(2);
    const tied = [...Array.from({ length: 8 }, (_, i) => fake(`r${i}`, 90, 30)), fake("first", 1, 80), fake("second", 2, 80)];
    expect(applyExploration(tied, 30).filter((i) => i.exploration).map((i) => i.id)).toEqual(["first", "second"]);
    expect(applyExploration([], 30)).toEqual([]);
  });

  it("does not mutate its input", () => {
    const input = ranked();
    const before = JSON.stringify(input);
    applyExploration(input, 30);
    expect(JSON.stringify(input)).toBe(before);
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

  it("shows importance only when the source reported engagement, but still ranks with the baseline", async () => {
    const owner = "baseline@example.com";
    const hn = await addSource(owner, { type: "hn", connector: "api", name: "HN" });
    const feed = await addSource(owner, { name: "Plain feed" });
    const measured = await addItem(hn, { owner, relevance: 50, importance: 20, metrics: { points: 5, comments: 1 }, title: "Measured" });
    const baseline = await addItem(feed, { owner, relevance: 50, importance: 20, metrics: {}, title: "Baseline" });
    const { items } = await listFeed({ ownerEmail: owner, limit: 10, now: NOW });
    expect(items.find((i) => i.id === measured)?.importance).toBe(20); // a real 20 is still shown
    expect(items.find((i) => i.id === baseline)?.importance).toBeNull(); // the flat baseline is hidden
    expect(items.map((i) => i.id).sort()).toEqual([measured, baseline].sort());
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

describe("exploration in listFeed", () => {
  it("adds exploration picks to the main feed only when importance is measured, and never to the saved view", async () => {
    const owner = "explore@example.com";
    const hn = await addSource(owner, { type: "hn", connector: "api", name: "HN" });
    const feed = await addSource(owner, { name: "Plain feed" });
    for (let i = 0; i < 8; i++) await addItem(hn, { owner, relevance: 90 - i, importance: 30, metrics: { points: 10, comments: 1 }, title: `Relevant ${i}` });
    const buzz = await addItem(hn, { owner, relevance: 10, importance: 90, metrics: { points: 900, comments: 400 }, title: "Everyone is talking about this" });
    await addItem(feed, { owner, relevance: 5, importance: 90, metrics: {}, title: "Baseline only" }); // importance is not measured

    const { items } = await listFeed({ ownerEmail: owner, limit: 30, now: NOW });
    const explored = items.filter((i) => i.exploration);
    expect(explored.map((i) => i.id)).toEqual([buzz]);
    expect(items[3].id).toBe(buzz);
    expect(items.find((i) => i.title === "Baseline only")?.exploration).toBe(false);

    // Save enough items that exploration *would* kick in if the saved view allowed it.
    for (const item of items.filter((i) => i.title.startsWith("Relevant"))) await recordSave(owner, item.id);
    await recordSave(owner, buzz);
    const saved = await listFeed({ ownerEmail: owner, limit: 30, view: "saved", now: NOW });
    expect(saved.items).toHaveLength(9);
    expect(saved.items.some((i) => i.exploration)).toBe(false);
    expect(saved.items[3].id).not.toBe(buzz); // not moved up to an exploration slot
  });

  it("drops an exploration pick once the user skips it", async () => {
    const owner = "explore-skip@example.com";
    const hn = await addSource(owner, { type: "hn", connector: "api", name: "HN" });
    for (let i = 0; i < 7; i++) await addItem(hn, { owner, relevance: 80 - i, importance: 30, metrics: { points: 5, comments: 0 } });
    const buzz = await addItem(hn, { owner, relevance: 5, importance: 95, metrics: { points: 1000, comments: 500 } });
    expect((await listFeed({ ownerEmail: owner, limit: 30, now: NOW })).items.some((i) => i.id === buzz && i.exploration)).toBe(true);
    await getDb().insert(schema.feedback).values({ id: crypto.randomUUID(), ownerEmail: owner, itemId: buzz, signal: "skip" });
    expect((await listFeed({ ownerEmail: owner, limit: 30, now: NOW })).items.some((i) => i.id === buzz)).toBe(false);
  });
});

async function recordSave(owner: string, itemId: string) {
  await getDb().insert(schema.feedback).values({ id: crypto.randomUUID(), ownerEmail: owner, itemId, signal: "save" });
}

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
