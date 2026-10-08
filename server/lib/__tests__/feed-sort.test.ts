import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const dir = mkdtempSync(join(tmpdir(), "observer-feed-sort-"));
process.env.DATABASE_URL = `pglite:${join(dir, "db")}`;

const { runMigrations, closeDbExec } = await import("@agent-native/core/db");
const { APP_MIGRATIONS, APP_MIGRATIONS_TABLE } = await import("../../db/migrations.js");
const { getDb, schema } = await import("../../db/index.js");
const { listFeed } = await import("../feed.js");
const { recordFeedback } = await import("../feedback.js");
const listFeedAction = (await import("../../../actions/list-feed.js")).default;

const NOW = Date.parse("2026-10-07T12:00:00.000Z");
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();

async function addSource(owner: string, over: Partial<typeof schema.sources.$inferInsert> = {}) {
  const id = crypto.randomUUID();
  await getDb().insert(schema.sources).values({ id, ownerEmail: owner, type: "rss", connector: "feed", name: "Feed", ...over });
  return id;
}
async function addItem(sourceId: string, owner: string, o: { title: string; relevance: number; hours: number; importance?: number; metrics?: object }) {
  const id = crypto.randomUUID();
  await getDb().insert(schema.items).values({ id, ownerEmail: owner, sourceId, externalId: id, url: `https://x.example.com/${id}`, title: o.title, postedAt: hoursAgo(o.hours), rawMetrics: JSON.stringify(o.metrics ?? {}) });
  await getDb().insert(schema.summaries).values({ id: crypto.randomUUID(), ownerEmail: owner, itemId: id, summaryText: "S.", inputHash: "h" });
  await getDb().insert(schema.scores).values({ id: crypto.randomUUID(), ownerEmail: owner, itemId: id, relevance: o.relevance, importance: o.importance ?? 20, reason: "r" });
  return id;
}
const read = (owner: string, itemId: string) => recordFeedback({ ownerEmail: owner, orgId: null, itemId, signal: "opened" });
const titles = (r: { items: { title: string }[] }) => r.items.map((i) => i.title);

beforeAll(async () => {
  await runMigrations(APP_MIGRATIONS, { table: APP_MIGRATIONS_TABLE })(null);
});
afterAll(async () => {
  await closeDbExec();
  rmSync(dir, { recursive: true, force: true });
});

describe("sort", () => {
  it("ranked (the default) is the blended score; newest is purely by date", async () => {
    const owner = "sort@example.com";
    const src = await addSource(owner);
    await addItem(src, owner, { title: "Old but very relevant", relevance: 95, hours: 30 });
    await addItem(src, owner, { title: "Fresh but meh", relevance: 20, hours: 1 });
    await addItem(src, owner, { title: "Middle", relevance: 60, hours: 10 });

    // Blended score: relevance 95 outweighs being a day old; relevance 20 can't be rescued by being fresh.
    const expectedRanked = ["Old but very relevant", "Middle", "Fresh but meh"];
    expect(titles(await listFeed({ ownerEmail: owner, limit: 10, now: NOW }))).toEqual(expectedRanked); // the default
    expect(titles(await listFeed({ ownerEmail: owner, limit: 10, sort: "ranked", now: NOW }))).toEqual(expectedRanked);
    expect(titles(await listFeed({ ownerEmail: owner, limit: 10, sort: "newest", now: NOW }))).toEqual(["Fresh but meh", "Middle", "Old but very relevant"]);
  });

  it("newest never moves items out of date order for exploration slots, and respects the limit", async () => {
    const owner = "newest-explore@example.com";
    const hn = await addSource(owner, { type: "hn", connector: "api", name: "HN" });
    for (let i = 0; i < 8; i++) await addItem(hn, owner, { title: `Item ${i}`, relevance: 80 - i, hours: 10 + i, metrics: { points: 5, comments: 0 } });
    await addItem(hn, owner, { title: "Buzzy outsider", relevance: 5, hours: 40, importance: 95, metrics: { points: 900, comments: 300 } });

    const ranked = await listFeed({ ownerEmail: owner, limit: 30, sort: "ranked", now: NOW });
    expect(ranked.items.some((i) => i.exploration)).toBe(true);
    const newest = await listFeed({ ownerEmail: owner, limit: 30, sort: "newest", now: NOW });
    expect(newest.items.some((i) => i.exploration)).toBe(false);
    expect(titles(newest)).toEqual([...Array.from({ length: 8 }, (_, i) => `Item ${i}`), "Buzzy outsider"]);
    expect(titles(await listFeed({ ownerEmail: owner, limit: 3, sort: "newest", now: NOW }))).toEqual(["Item 0", "Item 1", "Item 2"]);
  });

  it("still hides skipped items and shows the saved view in either order", async () => {
    const owner = "sort-views@example.com";
    const src = await addSource(owner);
    const a = await addItem(src, owner, { title: "A", relevance: 50, hours: 3 });
    const b = await addItem(src, owner, { title: "B", relevance: 90, hours: 6 });
    await recordFeedback({ ownerEmail: owner, orgId: null, itemId: a, signal: "skip" });
    expect(titles(await listFeed({ ownerEmail: owner, limit: 10, sort: "newest", now: NOW }))).toEqual(["B"]);
    await recordFeedback({ ownerEmail: owner, orgId: null, itemId: b, signal: "save" });
    expect(titles(await listFeed({ ownerEmail: owner, limit: 10, sort: "newest", view: "saved", now: NOW }))).toEqual(["B"]);
  });
});

describe("hide read", () => {
  it("leaves out items the user opened, and counts them", async () => {
    const owner = "hide@example.com";
    const src = await addSource(owner);
    const items = [];
    for (let i = 0; i < 4; i++) items.push(await addItem(src, owner, { title: `T${i}`, relevance: 90 - i * 10, hours: 2 + i }));
    await read(owner, items[0]);
    await read(owner, items[2]);

    const all = await listFeed({ ownerEmail: owner, limit: 10, now: NOW });
    expect(titles(all)).toEqual(["T0", "T1", "T2", "T3"]);
    expect(all.readCount).toBe(2);
    const unread = await listFeed({ ownerEmail: owner, limit: 10, hideRead: true, now: NOW });
    expect(titles(unread)).toEqual(["T1", "T3"]);
    expect(unread.readCount).toBe(2); // still tells the UI how many are hidden
  });

  it("applies before the limit, so the page fills with unread items", async () => {
    const owner = "hide-limit@example.com";
    const src = await addSource(owner);
    const ids = [];
    for (let i = 0; i < 6; i++) ids.push(await addItem(src, owner, { title: `T${i}`, relevance: 90 - i, hours: 2 + i }));
    for (const id of ids.slice(0, 3)) await read(owner, id); // the three best are read
    expect(titles(await listFeed({ ownerEmail: owner, limit: 3, now: NOW }))).toEqual(["T0", "T1", "T2"]);
    expect(titles(await listFeed({ ownerEmail: owner, limit: 3, hideRead: true, now: NOW }))).toEqual(["T3", "T4", "T5"]);
  });

  it("works with newest, with the saved view, and when everything is read", async () => {
    const owner = "hide-combo@example.com";
    const src = await addSource(owner);
    const a = await addItem(src, owner, { title: "A", relevance: 50, hours: 5 });
    const b = await addItem(src, owner, { title: "B", relevance: 50, hours: 2 });
    await read(owner, b);
    expect(titles(await listFeed({ ownerEmail: owner, limit: 10, sort: "newest", hideRead: true, now: NOW }))).toEqual(["A"]);

    await recordFeedback({ ownerEmail: owner, orgId: null, itemId: a, signal: "save" });
    await recordFeedback({ ownerEmail: owner, orgId: null, itemId: b, signal: "save" });
    expect(titles(await listFeed({ ownerEmail: owner, limit: 10, view: "saved", hideRead: true, now: NOW }))).toEqual(["A"]);

    await read(owner, a);
    const none = await listFeed({ ownerEmail: owner, limit: 10, hideRead: true, now: NOW });
    expect(none.items).toEqual([]);
    expect(none.readCount).toBe(2);
  });

  it("is per user", async () => {
    const mine = "hide-mine@example.com";
    const theirs = "hide-theirs@example.com";
    const mineItem = await addItem(await addSource(mine), mine, { title: "Mine", relevance: 50, hours: 1 });
    const theirItem = await addItem(await addSource(theirs), theirs, { title: "Theirs", relevance: 50, hours: 1 });
    await read(theirs, theirItem);
    expect(titles(await listFeed({ ownerEmail: mine, limit: 10, hideRead: true, now: NOW }))).toEqual(["Mine"]);
    expect((await listFeed({ ownerEmail: mine, limit: 10, now: NOW })).readCount).toBe(0);
    expect(mineItem).toBeTruthy();
  });
});

describe("list-feed action arguments", () => {
  // The action's Zod schema, which runs on every call (agent tool or HTTP).
  const schemaOf = listFeedAction as unknown as { schema: { parse(input: unknown): unknown } };
  const parse = (input: Record<string, unknown>) => schemaOf.schema.parse(input) as { sort: string; hideRead: boolean; view: string; limit: number };

  it("defaults to ranked, showing read items", () => {
    expect(parse({})).toMatchObject({ sort: "ranked", hideRead: false, view: "feed", limit: 30 });
  });

  it("accepts booleans and the strings a GET query string carries, and treats the string 'false' as false", () => {
    expect(parse({ hideRead: true }).hideRead).toBe(true);
    expect(parse({ hideRead: "true" }).hideRead).toBe(true);
    expect(parse({ hideRead: "false" }).hideRead).toBe(false);
    expect(parse({ sort: "newest" }).sort).toBe("newest");
  });

  it("rejects unknown values", () => {
    expect(() => parse({ sort: "random" })).toThrow();
    expect(() => parse({ hideRead: "yes" })).toThrow();
  });
});
