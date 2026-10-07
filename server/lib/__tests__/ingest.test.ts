import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const dir = mkdtempSync(join(tmpdir(), "observer-ingest-"));
process.env.DATABASE_URL = `pglite:${join(dir, "db")}`;

const { runMigrations, closeDbExec } = await import("@agent-native/core/db");
const { APP_MIGRATIONS, APP_MIGRATIONS_TABLE } = await import("../../db/migrations.js");
const { getDb, schema } = await import("../../db/index.js");
const { ingestSource } = await import("../ingest.js");
const { eq } = await import("drizzle-orm");

const ALICE = "alice@example.com";
const BOB = "bob@example.com";

const feed = (titles: string[]) =>
  `<rss version="2.0"><channel>${titles
    .map((t, i) => `<item><title>${t}</title><link>https://example.com/${i}</link><guid>g${i}</guid></item>`)
    .join("")}</channel></rss>`;

const fakeFetch = (xml: string) => async (url: string) => ({ text: xml, status: 200, contentType: "", finalUrl: url });

async function addSource(over: Partial<typeof schema.sources.$inferInsert> = {}) {
  const id = crypto.randomUUID();
  await getDb().insert(schema.sources).values({
    id, ownerEmail: ALICE, type: "rss", connector: "feed", name: "Test feed",
    config: JSON.stringify({ url: "https://example.com/feed.xml" }), ...over,
  });
  return id;
}

beforeAll(async () => {
  await runMigrations(APP_MIGRATIONS, { table: APP_MIGRATIONS_TABLE })(null);
});
afterAll(async () => {
  await closeDbExec();
  rmSync(dir, { recursive: true, force: true });
});

describe("ingestSource", () => {
  it("inserts new items, then updates (not duplicates) on re-fetch, and records runs + health", async () => {
    const sourceId = await addSource();

    const first = await ingestSource({ ownerEmail: ALICE, sourceId, fetchText: fakeFetch(feed(["One", "Two"])) });
    expect(first).toMatchObject({ fetched: 2, newItems: 2, updatedItems: 0 });

    const second = await ingestSource({ ownerEmail: ALICE, sourceId, fetchText: fakeFetch(feed(["One (edited)", "Two", "Three"])) });
    expect(second).toMatchObject({ fetched: 3, newItems: 1, updatedItems: 2 });

    const rows = await getDb().select().from(schema.items).where(eq(schema.items.sourceId, sourceId));
    expect(rows).toHaveLength(3);
    expect(rows.find((r) => r.externalId === "g0")?.title).toBe("One (edited)");
    expect(rows.every((r) => r.ownerEmail === ALICE)).toBe(true);

    const [source] = await getDb().select().from(schema.sources).where(eq(schema.sources.id, sourceId));
    expect(source).toMatchObject({ errorCount: 0, lastError: null });
    expect(source.lastSuccessAt).toBeTruthy();

    const runRows = await getDb().select().from(schema.runs).where(eq(schema.runs.sourceId, sourceId));
    expect(runRows.map((r) => r.status)).toEqual(["ok", "ok"]);
  });

  it("records failures on the source and the run, and counts consecutive errors", async () => {
    const sourceId = await addSource({ name: "Broken" });
    const boom = async () => { throw new Error("upstream exploded"); };

    await expect(ingestSource({ ownerEmail: ALICE, sourceId, fetchText: boom })).rejects.toThrow(/Broken.*upstream exploded/);
    await expect(ingestSource({ ownerEmail: ALICE, sourceId, fetchText: boom })).rejects.toThrow();

    const [source] = await getDb().select().from(schema.sources).where(eq(schema.sources.id, sourceId));
    expect(source.errorCount).toBe(2);
    expect(source.lastError).toContain("upstream exploded");

    const runRows = await getDb().select().from(schema.runs).where(eq(schema.runs.sourceId, sourceId));
    expect(runRows.map((r) => r.status)).toEqual(["error", "error"]);

    // A later success resets the health counters.
    await ingestSource({ ownerEmail: ALICE, sourceId, fetchText: fakeFetch(feed(["Back"])) });
    const [healed] = await getDb().select().from(schema.sources).where(eq(schema.sources.id, sourceId));
    expect(healed).toMatchObject({ errorCount: 0, lastError: null });
  });

  it("treats a non-feed response (e.g. an HTML error page) as a failure, not an empty success", async () => {
    const sourceId = await addSource({ name: "HTML page" });
    await expect(
      ingestSource({ ownerEmail: ALICE, sourceId, fetchText: fakeFetch("<html><body>Not found</body></html>") }),
    ).rejects.toThrow(/RSS or Atom/);
  });

  it("will not fetch another user's source", async () => {
    const sourceId = await addSource();
    await expect(ingestSource({ ownerEmail: BOB, sourceId, fetchText: fakeFetch(feed(["x"])) })).rejects.toThrow(/not found/i);
    const rows = await getDb().select().from(schema.items).where(eq(schema.items.sourceId, sourceId));
    expect(rows).toHaveLength(0);
  });

  it("refuses disabled or unapproved sources", async () => {
    const disabled = await addSource({ enabled: false });
    const candidate = await addSource({ status: "candidate" });
    for (const sourceId of [disabled, candidate]) {
      await expect(ingestSource({ ownerEmail: ALICE, sourceId, fetchText: fakeFetch(feed(["x"])) })).rejects.toThrow(/disabled or not approved/);
    }
  });

  it("applies the owner's denylist to feed fetches", async () => {
    await getDb().insert(schema.sourceSettings).values({
      id: crypto.randomUUID(), ownerEmail: ALICE, denylistDomains: JSON.stringify(["example.com"]),
    });
    const sourceId = await addSource({ name: "Denied" });
    // Use the real fetcher: the denylist check runs before any network access.
    await expect(ingestSource({ ownerEmail: ALICE, sourceId })).rejects.toThrow(/denylist/);
  });
});
