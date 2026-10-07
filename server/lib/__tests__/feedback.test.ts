import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const dir = mkdtempSync(join(tmpdir(), "observer-feedback-"));
process.env.DATABASE_URL = `pglite:${join(dir, "db")}`;

const { runMigrations, closeDbExec } = await import("@agent-native/core/db");
const { APP_MIGRATIONS, APP_MIGRATIONS_TABLE } = await import("../../db/migrations.js");
const { getDb, schema } = await import("../../db/index.js");
const { getFeedbackStates, recentFeedbackTitles, recordFeedback } = await import("../feedback.js");
const { listFeed } = await import("../feed.js");
const { getScoreInput } = await import("../scores.js");
const { eq } = await import("drizzle-orm");

const ALICE = "alice@example.com";
const BOB = "bob@example.com";
const NOW = Date.parse("2026-10-07T12:00:00.000Z");

const rec = (itemId: string, signal: "like" | "skip" | "save" | "opened", active?: boolean, owner = ALICE) =>
  recordFeedback({ ownerEmail: owner, orgId: null, itemId, signal, active });

async function addSource(owner = ALICE) {
  const id = crypto.randomUUID();
  await getDb().insert(schema.sources).values({ id, ownerEmail: owner, type: "rss", connector: "feed", name: "Feed" });
  return id;
}
async function addItem(sourceId: string, opts: { owner?: string; title?: string; relevance?: number } = {}) {
  const owner = opts.owner ?? ALICE;
  const id = crypto.randomUUID();
  await getDb().insert(schema.items).values({ id, ownerEmail: owner, sourceId, externalId: id, url: `https://x.example.com/${id}`, title: opts.title ?? "Title", postedAt: new Date(NOW - 3_600_000).toISOString() });
  await getDb().insert(schema.summaries).values({ id: crypto.randomUUID(), ownerEmail: owner, itemId: id, summaryText: "Summary.", inputHash: "h" });
  await getDb().insert(schema.scores).values({ id: crypto.randomUUID(), ownerEmail: owner, itemId: id, relevance: opts.relevance ?? 50, importance: 20, reason: "Because." });
  return id;
}

beforeAll(async () => {
  await runMigrations(APP_MIGRATIONS, { table: APP_MIGRATIONS_TABLE })(null);
});
afterAll(async () => {
  await closeDbExec();
  rmSync(dir, { recursive: true, force: true });
});

describe("recordFeedback", () => {
  it("sets and clears like, skip, and save, and reports the resulting state", async () => {
    const id = await addItem(await addSource());
    expect(await rec(id, "like")).toEqual({ itemId: id, liked: true, skipped: false, saved: false, opened: false });
    expect(await rec(id, "save")).toMatchObject({ liked: true, saved: true });
    expect(await rec(id, "like", false)).toMatchObject({ liked: false, saved: true });
    expect(await rec(id, "save", false)).toMatchObject({ liked: false, saved: false });
  });

  it("makes like and skip mutually exclusive but leaves save alone", async () => {
    const id = await addItem(await addSource());
    await rec(id, "save");
    await rec(id, "like");
    expect(await rec(id, "skip")).toMatchObject({ liked: false, skipped: true, saved: true });
    expect(await rec(id, "like")).toMatchObject({ liked: true, skipped: false, saved: true });
  });

  it("is idempotent: repeating a signal never duplicates it", async () => {
    const id = await addItem(await addSource());
    for (let i = 0; i < 3; i++) await rec(id, "like");
    await rec(id, "opened");
    await rec(id, "opened");
    const rows = await getDb().select().from(schema.feedback).where(eq(schema.feedback.itemId, id));
    expect(rows.map((r) => r.signal).sort()).toEqual(["like", "opened"]);
  });

  it("records opened but won't undo it", async () => {
    const id = await addItem(await addSource());
    expect(await rec(id, "opened")).toMatchObject({ opened: true });
    await expect(rec(id, "opened", false)).rejects.toThrow(/can't be undone/);
    expect((await getFeedbackStates(ALICE, [id])).get(id)?.opened).toBe(true);
  });

  it("is scoped to the owner", async () => {
    const id = await addItem(await addSource());
    await expect(rec(id, "like", true, BOB)).rejects.toThrow(/not found/i);
    expect(await getDb().select().from(schema.feedback).where(eq(schema.feedback.itemId, id))).toHaveLength(0);
    const bobSrc = await addSource(BOB);
    const bobItem = await addItem(bobSrc, { owner: BOB });
    await rec(bobItem, "like", true, BOB);
    expect((await getFeedbackStates(ALICE, [bobItem])).size).toBe(0);
  });
});

describe("feed and feedback", () => {
  it("hides skipped items from the feed, keeps liked ones, and exposes each item's state", async () => {
    const owner = "feed@example.com";
    const src = await addSource(owner);
    const kept = await addItem(src, { owner, relevance: 90 });
    const liked = await addItem(src, { owner, relevance: 80 });
    const skipped = await addItem(src, { owner, relevance: 70 });
    await recordFeedback({ ownerEmail: owner, orgId: null, itemId: liked, signal: "like" });
    await recordFeedback({ ownerEmail: owner, orgId: null, itemId: skipped, signal: "skip" });

    const { items } = await listFeed({ ownerEmail: owner, limit: 10, now: NOW });
    expect(items.map((i) => i.id)).toEqual([kept, liked]);
    expect(items.find((i) => i.id === liked)?.feedback).toEqual({ liked: true, skipped: false, saved: false, opened: false });
    expect(items.find((i) => i.id === kept)?.feedback).toEqual({ liked: false, skipped: false, saved: false, opened: false });

    // Undoing the skip brings it back.
    await recordFeedback({ ownerEmail: owner, orgId: null, itemId: skipped, signal: "skip", active: false });
    expect((await listFeed({ ownerEmail: owner, limit: 10, now: NOW })).items).toHaveLength(3);
  });

  it("lists saved items in the saved view, even ones skipped from the feed", async () => {
    const owner = "saved@example.com";
    const src = await addSource(owner);
    const a = await addItem(src, { owner, relevance: 90 });
    const b = await addItem(src, { owner, relevance: 60 });
    await addItem(src, { owner, relevance: 99 });
    for (const [id, signal] of [[a, "save"], [b, "save"], [b, "skip"]] as const) await recordFeedback({ ownerEmail: owner, orgId: null, itemId: id, signal });

    expect((await listFeed({ ownerEmail: owner, limit: 10, view: "saved", now: NOW })).items.map((i) => i.id)).toEqual([a, b]);
    expect((await listFeed({ ownerEmail: owner, limit: 10, view: "feed", now: NOW })).items.map((i) => i.id)).not.toContain(b);
    expect((await listFeed({ ownerEmail: "none@example.com", limit: 10, view: "saved", now: NOW })).items).toEqual([]);
  });
});

describe("feedback history for scoring", () => {
  it("gives the agent recent liked/saved and skipped titles, deduplicated and capped, per user", async () => {
    const owner = "history@example.com";
    const src = await addSource(owner);
    const likedAndSaved = await addItem(src, { owner, title: "Edge runtime benchmarks" });
    const skipped = await addItem(src, { owner, title: "Celebrity gossip" });
    for (let i = 0; i < 10; i++) await recordFeedback({ ownerEmail: owner, orgId: null, itemId: await addItem(src, { owner, title: `Extra ${i}` }), signal: "like" });
    await recordFeedback({ ownerEmail: owner, orgId: null, itemId: likedAndSaved, signal: "like" });
    await recordFeedback({ ownerEmail: owner, orgId: null, itemId: likedAndSaved, signal: "save" });
    await recordFeedback({ ownerEmail: owner, orgId: null, itemId: skipped, signal: "skip" });

    const history = await recentFeedbackTitles(owner);
    expect(history.liked.filter((t) => t === "Edge runtime benchmarks")).toHaveLength(1);
    expect(history.liked.length).toBeLessThanOrEqual(8);
    expect(history.skipped).toEqual(["Celebrity gossip"]);
    expect(await recentFeedbackTitles("nobody@example.com")).toEqual({ liked: [], skipped: [] });

    expect((await getScoreInput(owner, null, skipped)).feedbackHistory.skipped).toEqual(["Celebrity gossip"]);
  });
});
