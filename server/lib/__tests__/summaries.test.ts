import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const dir = mkdtempSync(join(tmpdir(), "observer-summaries-"));
process.env.DATABASE_URL = `pglite:${join(dir, "db")}`;

const { runMigrations, closeDbExec } = await import("@agent-native/core/db");
const { APP_MIGRATIONS, APP_MIGRATIONS_TABLE } = await import("../../db/migrations.js");
const { getDb, schema } = await import("../../db/index.js");
const { findUnsupportedQuotes, getSummaryInput, listPendingSummaries, normalizeForMatch, saveSummary, MAX_INPUT_CHARS } = await import("../summaries.js");
const { eq } = await import("drizzle-orm");

const ALICE = "alice@example.com";
const BOB = "bob@example.com";

const ARTICLE =
  "The city council voted 7-2 on Tuesday to approve the new transit levy. Supporters said the “levy will fund twelve new bus routes” over five years. " +
  "Opponents argued the measure raises property taxes by an average of $84 per household, and asked for a review after two years.";
const GOOD = {
  summaryText: "Councillors approved a transit levy by 7-2, which would pay for new bus routes; critics worry about the added property tax.",
  citations: [{ quote: "voted 7-2 on Tuesday to approve the new transit levy" }, { quote: 'levy will fund twelve new bus routes' }],
};

const hash = (s: string) => `hash-${s.length}`;
async function addItem(over: Partial<typeof schema.items.$inferInsert> = {}, owner = ALICE) {
  const id = crypto.randomUUID();
  await getDb().insert(schema.items).values({
    id, ownerEmail: owner, sourceId: "s1", externalId: id, url: `https://news.example.com/${id}`, title: "Council approves levy",
    fetchStatus: "ok", fetchedText: ARTICLE, fetchedTextHash: hash(ARTICLE), ...over,
  });
  return id;
}
const save = (itemId: string, over: Record<string, unknown> = {}, owner = ALICE) =>
  saveSummary({ ownerEmail: owner, orgId: null, itemId, ...GOOD, ...over } as Parameters<typeof saveSummary>[0]);

beforeAll(async () => {
  await runMigrations(APP_MIGRATIONS, { table: APP_MIGRATIONS_TABLE })(null);
});
afterAll(async () => {
  await closeDbExec();
  rmSync(dir, { recursive: true, force: true });
});

describe("citation matching", () => {
  it("tolerates typography and case but not changed wording", () => {
    expect(normalizeForMatch("It’s “fine” — really…")).toBe('it\'s "fine" - really...');
    expect(findUnsupportedQuotes(ARTICLE, [{ quote: 'levy will fund twelve new bus routes' }])).toEqual([]);
    expect(findUnsupportedQuotes(ARTICLE, [{ quote: "levy will fund twelve NEW  bus\nroutes" }])).toEqual([]);
    expect(findUnsupportedQuotes(ARTICLE, [{ quote: "levy will fund thirty new bus routes" }])).toHaveLength(1);
  });
});

describe("saveSummary", () => {
  it("stores a summary whose citations all appear in the article, with the text hash", async () => {
    const id = await addItem();
    expect(await save(id)).toMatchObject({ kind: "summary" });
    const [row] = await getDb().select().from(schema.summaries).where(eq(schema.summaries.itemId, id));
    expect(row.summaryText).toBe(GOOD.summaryText);
    expect(JSON.parse(row.citations)).toHaveLength(2);
    expect(row.inputHash).toBe(hash(ARTICLE));
    expect(row.ownerEmail).toBe(ALICE);
  });

  it("rejects a fabricated quote and stores nothing", async () => {
    const id = await addItem();
    await expect(save(id, { citations: [GOOD.citations[0], { quote: "the mayor resigned amid a corruption scandal" }] })).rejects.toThrow(/do not appear in the article/);
    expect(await getDb().select().from(schema.summaries).where(eq(schema.summaries.itemId, id))).toHaveLength(0);
  });

  it("enforces summary length, citation count, and quote length", async () => {
    const id = await addItem();
    await expect(save(id, { summaryText: "Too short." })).rejects.toThrow(/must be 40-700/);
    await expect(save(id, { summaryText: "x".repeat(701) })).rejects.toThrow(/must be 40-700/);
    await expect(save(id, { citations: [] })).rejects.toThrow(/1-8 citations/);
    await expect(save(id, { citations: undefined })).rejects.toThrow(/1-8 citations/);
    await expect(save(id, { citations: [{ quote: "7-2" }] })).rejects.toThrow(/20-300 characters/);
  });

  it("refuses to summarize an unreadable or unfetched article, and says what to do", async () => {
    const failed = await addItem({ fetchStatus: "failed", fetchedText: null, fetchedTextHash: null, fetchError: "The site refused access (HTTP 403)." });
    await expect(save(failed)).rejects.toThrow(/unavailable: true/);
    const pending = await addItem({ fetchStatus: "pending", fetchedText: null, fetchedTextHash: null });
    await expect(save(pending)).rejects.toThrow(/fetch-article-text/);
    await expect(save(pending, { unavailable: true })).rejects.toThrow(/fetch-article-text/);
  });

  it("writes the 'unavailable' text itself and ignores anything the caller supplies", async () => {
    const id = await addItem({ fetchStatus: "paywalled", fetchedText: null, fetchedTextHash: null, fetchError: "The page says its content is behind a paywall." });
    expect(await save(id, { unavailable: true, summaryText: "The article says the mayor resigned.", citations: [{ quote: "invented" }] })).toMatchObject({ kind: "unavailable" });
    const [row] = await getDb().select().from(schema.summaries).where(eq(schema.summaries.itemId, id));
    expect(row.summaryText).toBe("The article couldn't be read: The page says its content is behind a paywall.");
    expect(row.summaryText).not.toMatch(/mayor/);
    expect(JSON.parse(row.citations)).toEqual([]);
    expect(row.inputHash).toBeNull();
  });

  it("won't mark a readable article unavailable", async () => {
    const id = await addItem();
    await expect(save(id, { unavailable: true })).rejects.toThrow(/text is available/);
  });

  it("replaces the previous summary (one per item) and is scoped to the owner", async () => {
    const id = await addItem();
    await save(id);
    await save(id, { summaryText: "A second, reworded summary of the council's 7-2 vote on the transit levy." });
    const rows = await getDb().select().from(schema.summaries).where(eq(schema.summaries.itemId, id));
    expect(rows).toHaveLength(1);
    expect(rows[0].summaryText).toMatch(/second, reworded/);
    await expect(save(id, {}, BOB)).rejects.toThrow(/not found/i);
  });
});

describe("getSummaryInput and listPendingSummaries", () => {
  it("returns article text, flags unreadable articles with the reason, and truncates long text", async () => {
    const ok = await addItem();
    const input = await getSummaryInput(ALICE, ok);
    expect(input.article).toMatchObject({ readable: true, status: "ok", truncated: false, reason: null });
    expect(input.article.text).toContain("transit levy");
    expect(input.existing).toBeNull();

    const long = await addItem({ fetchedText: "word ".repeat(MAX_INPUT_CHARS), fetchedTextHash: "long" });
    const longInput = await getSummaryInput(ALICE, long);
    expect(longInput.article.text!.length).toBe(MAX_INPUT_CHARS);
    expect(longInput.article.truncated).toBe(true);

    const failed = await addItem({ fetchStatus: "failed", fetchedText: null, fetchedTextHash: null, fetchError: "Blocked." });
    expect((await getSummaryInput(ALICE, failed)).article).toMatchObject({ readable: false, text: null, reason: "Blocked." });
    await expect(getSummaryInput(BOB, ok)).rejects.toThrow(/not found/i);
  });

  it("marks a summary stale when the article text changes, and lists only what needs work", async () => {
    const owner = "dana@example.com";
    const fresh = await addItem({}, owner);
    const done = await addItem({}, owner);
    await save(done, {}, owner);
    const stale = await addItem({}, owner);
    await save(stale, {}, owner);
    await getDb().update(schema.items).set({ fetchedText: ARTICLE + " Update: the vote was certified.", fetchedTextHash: "changed" }).where(eq(schema.items.id, stale));
    const unreadable = await addItem({ fetchStatus: "failed", fetchedText: null, fetchedTextHash: null, fetchError: "x" }, owner);
    const unreadableDone = await addItem({ fetchStatus: "failed", fetchedText: null, fetchedTextHash: null, fetchError: "x" }, owner);
    await save(unreadableDone, { unavailable: true }, owner);
    await addItem({ fetchStatus: "pending", fetchedText: null, fetchedTextHash: null }, owner);

    expect((await getSummaryInput(owner, done)).existing?.upToDate).toBe(true);
    expect((await getSummaryInput(owner, stale)).existing?.upToDate).toBe(false);

    const pending = (await listPendingSummaries(owner, 25)).map((p) => p.id).sort();
    expect(pending).toEqual([fresh, stale, unreadable].sort());
    expect(await listPendingSummaries(owner, 2)).toHaveLength(2);
    expect(await listPendingSummaries(BOB, 25)).toEqual([]);
  });
});
