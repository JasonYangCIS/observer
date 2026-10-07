import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const dir = mkdtempSync(join(tmpdir(), "observer-interests-"));
process.env.DATABASE_URL = `pglite:${join(dir, "db")}`;

const { runMigrations, closeDbExec } = await import("@agent-native/core/db");
const { APP_MIGRATIONS, APP_MIGRATIONS_TABLE } = await import("../../db/migrations.js");
const { getDb, schema } = await import("../../db/index.js");
const { DEFAULT_INTEREST_PROFILE, MAX_PROFILE_CHARS, cleanProfileText, ensureInterestProfile, getInterests, updateInterests } = await import("../interests.js");
const { getScoreInput, listPendingScores, saveScore } = await import("../scores.js");
const { eq } = await import("drizzle-orm");

const ALICE = "alice@example.com";
const BOB = "bob@example.com";
const NEW_TEXT = "I want more edge rendering and WebAssembly, and less crypto and general politics.";

const update = (profileText: string, owner = ALICE) => updateInterests({ ownerEmail: owner, orgId: null, profileText });

async function addScoredItem(owner: string, opts: { daysOld?: number; title?: string } = {}) {
  const src = crypto.randomUUID();
  await getDb().insert(schema.sources).values({ id: src, ownerEmail: owner, type: "rss", connector: "feed", name: "Feed" });
  const id = crypto.randomUUID();
  const created = new Date(Date.now() - (opts.daysOld ?? 0) * 86_400_000).toISOString();
  await getDb().insert(schema.items).values({ id, ownerEmail: owner, sourceId: src, externalId: id, url: `https://x.example.com/${id}`, title: opts.title ?? "T", createdAt: created });
  await getDb().insert(schema.summaries).values({ id: crypto.randomUUID(), ownerEmail: owner, itemId: id, summaryText: "Summary.", inputHash: "h" });
  await saveScore({ ownerEmail: owner, orgId: null, itemId: id, relevance: 10, matchedInterests: [], reason: "Not related to anything the user said they follow." });
  return id;
}
/** Make the score look as old as `msAgo`, as if written before the next profile edit. */
const ageScore = (itemId: string, msAgo: number) =>
  getDb().update(schema.scores).set({ createdAt: new Date(Date.now() - msAgo).toISOString() }).where(eq(schema.scores.itemId, itemId));

beforeAll(async () => {
  await runMigrations(APP_MIGRATIONS, { table: APP_MIGRATIONS_TABLE })(null);
});
afterAll(async () => {
  await closeDbExec();
  rmSync(dir, { recursive: true, force: true });
});

describe("cleanProfileText", () => {
  it("strips control characters and tidies whitespace without touching the words", () => {
    expect(cleanProfileText("  I like\u0000 edge   rendering.\r\n\r\n\r\n\r\nNo crypto. \t ")).toBe("I like edge rendering.\n\nNo crypto.");
  });
});

describe("getInterests", () => {
  it("creates the default profile once and reports it as default", async () => {
    const view = await getInterests(ALICE, null);
    expect(view).toMatchObject({ profileText: DEFAULT_INTEREST_PROFILE, isDefault: true, defaultText: DEFAULT_INTEREST_PROFILE, staleScores: 0 });
    expect(view.updatedAt).toBeTruthy();
    expect(await getDb().select().from(schema.interestProfiles).where(eq(schema.interestProfiles.ownerEmail, ALICE))).toHaveLength(1);
  });
});

describe("updateInterests", () => {
  it("validates length and stores cleaned text", async () => {
    await expect(update("Too short")).rejects.toThrow(/20-2000/);
    await expect(update("x".repeat(MAX_PROFILE_CHARS + 1))).rejects.toThrow(/20-2000/);
    const saved = await update(`  ${NEW_TEXT}\r\n\r\n\r\n  `);
    expect(saved).toMatchObject({ profileText: NEW_TEXT, isDefault: false, changed: true });
  });

  it("does nothing when the text is unchanged, so scores aren't made stale", async () => {
    const before = await getInterests(ALICE, null);
    const again = await update(NEW_TEXT);
    expect(again.changed).toBe(false);
    expect(again.updatedAt).toBe(before.updatedAt);
  });

  it("is per user", async () => {
    expect((await getInterests(BOB, null)).profileText).toBe(DEFAULT_INTEREST_PROFILE);
    await update("Only distributed systems and databases, nothing else at all please.", BOB);
    expect((await getInterests(ALICE, null)).profileText).toBe(NEW_TEXT);
  });
});

describe("re-scoring after the profile changes", () => {
  it("makes recent scores stale, queues them after new items, and clears when re-scored", async () => {
    const owner = "rescore@example.com";
    await ensureInterestProfile(owner, null);
    const scored = await addScoredItem(owner, { title: "Already scored" });
    expect((await getInterests(owner, null)).staleScores).toBe(0);
    expect(await listPendingScores(owner, 25)).toEqual([]);
    expect((await getScoreInput(owner, null, scored)).existingScore?.stale).toBe(false);

    // The profile changes after the score was written.
    await ageScore(scored, 60_000);
    await update("I only follow rust, compilers, and programming language design now.", owner);
    expect((await getInterests(owner, null)).staleScores).toBe(1);
    expect((await getScoreInput(owner, null, scored)).existingScore?.stale).toBe(true);

    // A brand-new summarized item (no score yet) sorts ahead of the stale one.
    const src = (await getDb().select().from(schema.items).where(eq(schema.items.id, scored)))[0].sourceId;
    const fresh = crypto.randomUUID();
    await getDb().insert(schema.items).values({ id: fresh, ownerEmail: owner, sourceId: src, externalId: fresh, url: `https://x.example.com/${fresh}`, title: "Fresh" });
    await getDb().insert(schema.summaries).values({ id: crypto.randomUUID(), ownerEmail: owner, itemId: fresh, summaryText: "S.", inputHash: "h" });
    const pending = await listPendingScores(owner, 25);
    expect(pending.map((p) => [p.title, p.reason])).toEqual([["Fresh", "new"], ["Already scored", "interests_changed"]]);
    expect(await listPendingScores(owner, 1)).toHaveLength(1);

    // Re-scoring the stale item clears it.
    await saveScore({ ownerEmail: owner, orgId: null, itemId: scored, relevance: 5, matchedInterests: [], reason: "Still unrelated to compilers and language design." });
    expect((await getInterests(owner, null)).staleScores).toBe(0);
    expect((await getScoreInput(owner, null, scored)).existingScore?.stale).toBe(false);
    expect((await listPendingScores(owner, 25)).map((p) => p.title)).toEqual(["Fresh"]);
  });

  it("leaves old items alone (cost bound) and other users' scores untouched", async () => {
    const owner = "window@example.com";
    await ensureInterestProfile(owner, null);
    const old = await addScoredItem(owner, { daysOld: 30, title: "Old" });
    const recent = await addScoredItem(owner, { title: "Recent" });
    await ageScore(old, 60_000);
    await ageScore(recent, 60_000);
    await update("Totally new interests: gardening, ceramics, and slow cooking recipes.", owner);

    expect((await getInterests(owner, null)).staleScores).toBe(1);
    expect((await listPendingScores(owner, 25)).map((p) => p.title)).toEqual(["Recent"]);
    expect((await getInterests(BOB, null)).staleScores).toBe(0);
    expect(await listPendingScores("nobody@example.com", 25)).toEqual([]);
  });
});
