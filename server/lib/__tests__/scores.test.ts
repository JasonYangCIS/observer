import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const dir = mkdtempSync(join(tmpdir(), "observer-scores-"));
process.env.DATABASE_URL = `pglite:${join(dir, "db")}`;

const { runMigrations, closeDbExec } = await import("@agent-native/core/db");
const { APP_MIGRATIONS, APP_MIGRATIONS_TABLE } = await import("../../db/migrations.js");
const { getDb, schema } = await import("../../db/index.js");
const { BASELINE_IMPORTANCE, computeImportance, findUnknownInterests, getScoreInput, listPendingScores, saveScore } = await import("../scores.js");
const { DEFAULT_INTEREST_PROFILE, ensureInterestProfile } = await import("../interests.js");
const { eq } = await import("drizzle-orm");

const ALICE = "alice@example.com";
const BOB = "bob@example.com";
const REASON = "Covers edge rendering performance, which the user follows closely.";

async function addSource(type = "hn", owner = ALICE) {
  const id = crypto.randomUUID();
  await getDb().insert(schema.sources).values({ id, ownerEmail: owner, type, connector: type === "hn" ? "api" : "feed", name: type === "hn" ? "Hacker News" : "A feed" });
  return id;
}
async function addItem(opts: { sourceId: string; metrics?: object; summarized?: boolean; owner?: string; postedAt?: string }) {
  const owner = opts.owner ?? ALICE;
  const id = crypto.randomUUID();
  await getDb().insert(schema.items).values({
    id, ownerEmail: owner, sourceId: opts.sourceId, externalId: id, url: `https://x.example.com/${id}`, title: "Edge rendering gets faster",
    rawMetrics: JSON.stringify(opts.metrics ?? {}), postedAt: opts.postedAt,
  });
  if (opts.summarized !== false) {
    await getDb().insert(schema.summaries).values({ id: crypto.randomUUID(), ownerEmail: owner, itemId: id, summaryText: "A short summary.", inputHash: "h" });
  }
  return id;
}
const save = (itemId: string, over: Record<string, unknown> = {}, owner = ALICE) =>
  saveScore({ ownerEmail: owner, orgId: null, itemId, relevance: 85, matchedInterests: ["web development"], reason: REASON, ...over } as Parameters<typeof saveScore>[0]);

beforeAll(async () => {
  await runMigrations(APP_MIGRATIONS, { table: APP_MIGRATIONS_TABLE })(null);
});
afterAll(async () => {
  await closeDbExec();
  rmSync(dir, { recursive: true, force: true });
});

describe("computeImportance", () => {
  it("scales with engagement, stays within 0-100, and explains itself", () => {
    const quiet = computeImportance("hn", JSON.stringify({ points: 5, comments: 0 }));
    const mid = computeImportance("hn", JSON.stringify({ points: 150, comments: 80 }));
    const huge = computeImportance("hn", JSON.stringify({ points: 50000, comments: 20000 }));
    expect(quiet.score).toBeLessThan(mid.score);
    expect(mid.score).toBeLessThan(huge.score);
    expect(huge.score).toBe(100);
    expect(mid.reason).toBe("150 points and 80 comments on Hacker News.");
    expect(computeImportance("hn", JSON.stringify({ points: 0, comments: 0 })).score).toBe(0);
  });

  it("gives sources with no engagement data a low, honest baseline", () => {
    for (const raw of ["{}", "not json", "null"]) {
      expect(computeImportance("rss", raw)).toMatchObject({ score: BASELINE_IMPORTANCE });
    }
    expect(computeImportance("rss", "{}").reason).toMatch(/No engagement data/);
  });
});

describe("interest profile", () => {
  it("seeds a default profile once and keeps the user's edits", async () => {
    expect(await ensureInterestProfile(ALICE, null)).toBe(DEFAULT_INTEREST_PROFILE);
    await getDb().update(schema.interestProfiles).set({ profileText: "Only edge rendering and WebAssembly." }).where(eq(schema.interestProfiles.ownerEmail, ALICE));
    expect(await ensureInterestProfile(ALICE, null)).toBe("Only edge rendering and WebAssembly.");
    expect(await getDb().select().from(schema.interestProfiles).where(eq(schema.interestProfiles.ownerEmail, ALICE))).toHaveLength(1);
    await getDb().update(schema.interestProfiles).set({ profileText: DEFAULT_INTEREST_PROFILE }).where(eq(schema.interestProfiles.ownerEmail, ALICE));
  });

  it("matches whole phrases from the profile only", () => {
    const profile = "I follow web development, edge rendering, and AI.";
    expect(findUnknownInterests(profile, ["Web Development", "edge   rendering", "AI"])).toEqual([]);
    expect(findUnknownInterests(profile, ["web"])).toEqual([]); // a whole word the user wrote
    expect(findUnknownInterests(profile, ["crypto", "render", "devel"])).toEqual(["crypto", "render", "devel"]); // partial words are not

    expect(findUnknownInterests("I like maintaining servers.", ["ai"])).toEqual(["ai"]); // not inside "maintaining"
  });
});

describe("saveScore", () => {
  it("stores relevance plus the server-computed importance and a reason that shows both bases", async () => {
    const itemId = await addItem({ sourceId: await addSource("hn"), metrics: { points: 150, comments: 80 } });
    const saved = await save(itemId);
    expect(saved.relevance).toBe(85);
    expect(saved.importance).toBe(computeImportance("hn", JSON.stringify({ points: 150, comments: 80 })).score);
    expect(saved.reason).toBe(`${REASON} Matched: web development. Buzz: 150 points and 80 comments on Hacker News.`);
    const [row] = await getDb().select().from(schema.scores).where(eq(schema.scores.itemId, itemId));
    expect(row).toMatchObject({ ownerEmail: ALICE, relevance: 85, importance: saved.importance });
  });

  it("ignores any importance the caller tries to supply", async () => {
    const itemId = await addItem({ sourceId: await addSource("rss"), metrics: {} });
    const saved = await save(itemId, { importance: 99 });
    expect(saved.importance).toBe(BASELINE_IMPORTANCE);
  });

  it("requires a summary, a valid 0-100 integer, and a reason of sensible length", async () => {
    const src = await addSource("rss");
    const unsummarized = await addItem({ sourceId: src, summarized: false });
    await expect(save(unsummarized)).rejects.toThrow(/Summarize this item first/);
    const itemId = await addItem({ sourceId: src });
    for (const relevance of [-1, 101, 55.5, Number.NaN]) await expect(save(itemId, { relevance })).rejects.toThrow(/whole number from 0 to 100/);
    await expect(save(itemId, { reason: "Relevant." })).rejects.toThrow(/20-300/);
    await expect(save(itemId, { reason: "x".repeat(301) })).rejects.toThrow(/20-300/);
  });

  it("rejects interests the user never wrote, and high relevance with no cited interest", async () => {
    const itemId = await addItem({ sourceId: await addSource("rss") });
    await expect(save(itemId, { matchedInterests: ["quantum cooking"] })).rejects.toThrow(/not in the user's interest profile: "quantum cooking"/);
    await expect(save(itemId, { relevance: 50, matchedInterests: [] })).rejects.toThrow(/must cite at least one/);
    const low = await save(itemId, { relevance: 10, matchedInterests: [], reason: "Not related to anything the user said they follow." });
    expect(low.reason).toBe("Not related to anything the user said they follow. Buzz: No engagement data from this source, so importance is a low baseline.");
  });

  it("keeps one score per owner and item, and is scoped to the owner", async () => {
    const itemId = await addItem({ sourceId: await addSource("rss") });
    await save(itemId, { relevance: 60 });
    await save(itemId, { relevance: 90 });
    const rows = await getDb().select().from(schema.scores).where(eq(schema.scores.itemId, itemId));
    expect(rows).toHaveLength(1);
    expect(rows[0].relevance).toBe(90);
    await expect(save(itemId, {}, BOB)).rejects.toThrow(/not found/i);
  });
});

describe("getScoreInput and listPendingScores", () => {
  it("returns summary, importance, the profile, and the existing score", async () => {
    const itemId = await addItem({ sourceId: await addSource("hn"), metrics: { points: 10, comments: 2 } });
    const before = await getScoreInput(ALICE, null, itemId);
    expect(before).toMatchObject({ source: { type: "hn" }, summary: { text: "A short summary." }, interests: DEFAULT_INTEREST_PROFILE, existingScore: null });
    expect(before.importance.reason).toBe("10 points and 2 comments on Hacker News.");
    await save(itemId);
    expect((await getScoreInput(ALICE, null, itemId)).existingScore?.relevance).toBe(85);
    await expect(getScoreInput(BOB, null, itemId)).rejects.toThrow(/not found/i);
  });

  it("lists only summarized, unscored items for the owner", async () => {
    const owner = "carol@example.com";
    const src = await addSource("rss", owner);
    const pendingId = await addItem({ sourceId: src, owner });
    const scoredId = await addItem({ sourceId: src, owner });
    await save(scoredId, {}, owner);
    await addItem({ sourceId: src, owner, summarized: false });
    expect((await listPendingScores(owner, 25)).map((p) => p.id)).toEqual([pendingId]);
    expect(await listPendingScores(BOB, 25)).toEqual([]);
  });
});
