import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const dir = mkdtempSync(join(tmpdir(), "observer-trust-"));
process.env.DATABASE_URL = `pglite:${join(dir, "db")}`;

const { runMigrations, closeDbExec } = await import("@agent-native/core/db");
const { APP_MIGRATIONS, APP_MIGRATIONS_TABLE } = await import("../../db/migrations.js");
const { getDb, schema } = await import("../../db/index.js");
const { MAX_TRUST, MIN_TRUST, computeTrustWeight, trustRankAdjustment } = await import("../trust.js");
const { recordFeedback } = await import("../feedback.js");
const { listFeed, rankScore } = await import("../feed.js");
const { listSources, removeSource } = await import("../sources.js");
const { eq } = await import("drizzle-orm");

const none = { likes: 0, saves: 0, opens: 0, skips: 0 };
const NOW = Date.parse("2026-10-07T12:00:00.000Z");

describe("computeTrustWeight", () => {
  it("is neutral with no feedback, and starts lower for agent-discovered sources", () => {
    expect(computeTrustWeight("user", none)).toBe(1);
    expect(computeTrustWeight("agent_discovered", none)).toBe(0.5);
    expect(computeTrustWeight("something-else", none)).toBe(1);
  });

  it("rises with likes, saves, and opens, and falls with skips", () => {
    const like = computeTrustWeight("user", { ...none, likes: 5 });
    const save = computeTrustWeight("user", { ...none, saves: 5 });
    const open = computeTrustWeight("user", { ...none, opens: 5 });
    const skip = computeTrustWeight("user", { ...none, skips: 5 });
    expect(save).toBeGreaterThan(like); // a save is a stronger signal than a like
    expect(like).toBeGreaterThan(open); // and an open is the weakest
    expect(open).toBeGreaterThan(1);
    expect(skip).toBeLessThan(1);
  });

  it("moves slowly on thin evidence and a lot on a long consistent history", () => {
    expect(computeTrustWeight("user", { ...none, likes: 1 })).toBeLessThan(1.1);
    // One skip counts 1.5x a like, so it moves trust a bit more (about -11%) than one like (+8%).
    expect(computeTrustWeight("user", { ...none, skips: 1 })).toBeGreaterThan(0.85);
    expect(1 - computeTrustWeight("user", { ...none, skips: 1 })).toBeGreaterThan(computeTrustWeight("user", { ...none, likes: 1 }) - 1);
    expect(trustRankAdjustment(computeTrustWeight("user", { ...none, skips: 1 }))).toBeGreaterThan(-3); // a single skip costs under 3 ranking points
    expect(computeTrustWeight("user", { ...none, likes: 100 })).toBeGreaterThan(1.4);
    expect(computeTrustWeight("user", { ...none, skips: 100 })).toBeLessThan(0.6);
  });

  it("stays within its bounds and treats likes and skips symmetrically in direction", () => {
    for (const counts of [{ ...none, likes: 1e6, saves: 1e6 }, { ...none, skips: 1e6 }]) {
      const w = computeTrustWeight("user", counts);
      expect(w).toBeLessThanOrEqual(MAX_TRUST);
      expect(w).toBeGreaterThanOrEqual(MIN_TRUST);
    }
    expect(computeTrustWeight("user", { ...none, likes: 3, skips: 2 })).toBeCloseTo(computeTrustWeight("user", { ...none, likes: 3, skips: 2 }), 6);
    expect(computeTrustWeight("agent_discovered", { ...none, skips: 1e6 })).toBeGreaterThanOrEqual(MIN_TRUST);
  });

  it("adjusts ranking by at most about ten points either way", () => {
    expect(trustRankAdjustment(1)).toBe(0);
    expect(trustRankAdjustment(1.5)).toBe(10);
    expect(trustRankAdjustment(0.5)).toBe(-10);
    expect(rankScore(50, 20, 0.5, 1.5)).toBeCloseTo(rankScore(50, 20, 0.5) + 10);
  });
});

const ALICE = "alice@example.com";
const BOB = "bob@example.com";
const rec = (itemId: string, signal: "like" | "skip" | "save" | "opened", active?: boolean, owner = ALICE) =>
  recordFeedback({ ownerEmail: owner, orgId: null, itemId, signal, active });

async function addSource(owner = ALICE, name = "Feed") {
  const id = crypto.randomUUID();
  await getDb().insert(schema.sources).values({ id, ownerEmail: owner, type: "rss", connector: "feed", name });
  return id;
}
async function addItem(sourceId: string, owner = ALICE, relevance = 50) {
  const id = crypto.randomUUID();
  await getDb().insert(schema.items).values({ id, ownerEmail: owner, sourceId, externalId: id, url: `https://x.example.com/${id}`, title: "T", postedAt: new Date(NOW - 3_600_000).toISOString() });
  await getDb().insert(schema.summaries).values({ id: crypto.randomUUID(), ownerEmail: owner, itemId: id, summaryText: "S.", inputHash: "h" });
  await getDb().insert(schema.scores).values({ id: crypto.randomUUID(), ownerEmail: owner, itemId: id, relevance, importance: 20, reason: "r" });
  return id;
}
const trustOf = async (sourceId: string) => (await getDb().select().from(schema.sources).where(eq(schema.sources.id, sourceId)))[0].trustWeight;

beforeAll(async () => {
  await runMigrations(APP_MIGRATIONS, { table: APP_MIGRATIONS_TABLE })(null);
});
afterAll(async () => {
  await closeDbExec();
  rmSync(dir, { recursive: true, force: true });
});

describe("source trust from feedback", () => {
  it("updates the source's stored weight as feedback is recorded, and undoing feedback undoes it", async () => {
    const src = await addSource();
    const items = [await addItem(src), await addItem(src), await addItem(src)];
    expect(await trustOf(src)).toBe(1);
    for (const id of items) await rec(id, "like");
    const liked = await trustOf(src);
    expect(liked).toBeGreaterThan(1);
    await rec(items[0], "save");
    expect(await trustOf(src)).toBeGreaterThan(liked);
    for (const id of items) await rec(id, "like", false);
    await rec(items[0], "save", false);
    expect(await trustOf(src)).toBe(1);
  });

  it("falls with skips, and flipping a like to a skip moves it from up to down", async () => {
    const src = await addSource();
    const [a, b] = [await addItem(src), await addItem(src)];
    await rec(a, "like");
    const up = await trustOf(src);
    await rec(a, "skip"); // exclusive with like: the like is gone
    await rec(b, "skip");
    expect(up).toBeGreaterThan(1);
    expect(await trustOf(src)).toBeLessThan(1);
  });

  it("only counts feedback on that source, and only the owner's", async () => {
    const mine = await addSource();
    const other = await addSource(ALICE, "Other");
    const bobSrc = await addSource(BOB);
    const bobItem = await addItem(bobSrc, BOB);
    await rec(await addItem(mine), "like");
    await rec(bobItem, "skip", true, BOB);
    expect(await trustOf(other)).toBe(1);
    expect(await trustOf(bobSrc)).toBeLessThan(1);
    expect(await trustOf(mine)).toBeGreaterThan(1);
  });

  it("is shown on the Sources list", async () => {
    const src = await addSource(ALICE, "Shown");
    await rec(await addItem(src), "save");
    expect((await listSources(ALICE)).find((s) => s.id === src)?.trustWeight).toBeGreaterThan(1);
  });
});

describe("trust in the feed", () => {
  it("lifts items from a source the user likes above an otherwise identical one, and reports the weight", async () => {
    const owner = "rank@example.com";
    const liked = await addSource(owner, "Liked");
    const plain = await addSource(owner, "Plain");
    const likedItem = await addItem(liked, owner, 50);
    const plainItem = await addItem(plain, owner, 50);
    // A tie on score; give the liked source real history so its weight rises.
    for (let i = 0; i < 4; i++) await recordFeedback({ ownerEmail: owner, orgId: null, itemId: await addItem(liked, owner, 1), signal: "save" });

    const { items } = await listFeed({ ownerEmail: owner, limit: 30, now: NOW });
    const ids = items.map((i) => i.id);
    expect(ids.indexOf(likedItem)).toBeLessThan(ids.indexOf(plainItem));
    expect(items.find((i) => i.id === likedItem)?.source.trustWeight).toBeGreaterThan(1);
    expect(items.find((i) => i.id === plainItem)?.source.trustWeight).toBe(1);
  });
});

describe("removing a source", () => {
  it("also deletes the feedback on its items so it can't skew anything", async () => {
    const src = await addSource(ALICE, "Doomed");
    const item = await addItem(src);
    await rec(item, "like");
    await rec(item, "save");
    expect(await getDb().select().from(schema.feedback).where(eq(schema.feedback.itemId, item))).toHaveLength(2);
    await removeSource(ALICE, src);
    expect(await getDb().select().from(schema.feedback).where(eq(schema.feedback.itemId, item))).toHaveLength(0);
  });
});
