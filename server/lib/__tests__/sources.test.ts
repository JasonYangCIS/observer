import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const dir = mkdtempSync(join(tmpdir(), "observer-sources-"));
process.env.DATABASE_URL = `pglite:${join(dir, "db")}`;

const { runMigrations, closeDbExec } = await import("@agent-native/core/db");
const { APP_MIGRATIONS, APP_MIGRATIONS_TABLE } = await import("../../db/migrations.js");
const { getDb, schema } = await import("../../db/index.js");
const { addSource, listSources, normalizeFeedUrl, removeSource, updateSource } = await import("../sources.js");
const { ingestSource } = await import("../ingest.js");
const { eq } = await import("drizzle-orm");

const ALICE = "alice@example.com";
const BOB = "bob@example.com";

beforeAll(async () => {
  await runMigrations(APP_MIGRATIONS, { table: APP_MIGRATIONS_TABLE })(null);
});
afterAll(async () => {
  await closeDbExec();
  rmSync(dir, { recursive: true, force: true });
});

describe("normalizeFeedUrl", () => {
  it("accepts http(s), strips the fragment, and rejects everything else", () => {
    expect(normalizeFeedUrl(" https://example.com/feed.xml#x ")).toBe("https://example.com/feed.xml");
    for (const bad of ["file:///etc/passwd", "javascript:alert(1)", "ftp://x.test/f", "nope", "https://user:pw@example.com/f"]) {
      expect(() => normalizeFeedUrl(bad)).toThrow();
    }
  });
});

describe("source management", () => {
  it("adds HN and RSS sources, creates default settings, and rejects duplicates", async () => {
    const hn = await addSource({ ownerEmail: ALICE, orgId: null, type: "hn", limit: 20 });
    expect(hn).toMatchObject({ name: "Hacker News", type: "hn", connector: "api", limit: 20, enabled: true, status: "approved", origin: "user" });
    await expect(addSource({ ownerEmail: ALICE, orgId: null, type: "hn" })).rejects.toThrow(/already added/);

    const rss = await addSource({ ownerEmail: ALICE, orgId: null, type: "rss", url: "https://blog.example.com/feed.xml#top" });
    expect(rss).toMatchObject({ name: "blog.example.com", connector: "feed", url: "https://blog.example.com/feed.xml" });
    await expect(addSource({ ownerEmail: ALICE, orgId: null, type: "rss", url: "https://blog.example.com/feed.xml" })).rejects.toThrow(/already added/);
    await expect(addSource({ ownerEmail: ALICE, orgId: null, type: "rss" })).rejects.toThrow(/URL is required/);

    const settings = await getDb().select().from(schema.sourceSettings).where(eq(schema.sourceSettings.ownerEmail, ALICE));
    expect(settings).toHaveLength(1);
    expect(settings[0].mode).toBe("trusted_only");
  });

  it("scopes everything to the owner", async () => {
    const [mine] = await listSources(ALICE);
    expect(await listSources(BOB)).toEqual([]);
    await expect(updateSource({ ownerEmail: BOB, id: mine.id, enabled: false })).rejects.toThrow(/not found/i);
    await expect(removeSource(BOB, mine.id)).rejects.toThrow(/not found/i);
    expect((await listSources(ALICE)).find((s) => s.id === mine.id)?.enabled).toBe(true);
  });

  it("enables/disables, renames, and requires something to change", async () => {
    const [src] = await listSources(ALICE);
    expect((await updateSource({ ownerEmail: ALICE, id: src.id, enabled: false })).enabled).toBe(false);
    expect((await updateSource({ ownerEmail: ALICE, id: src.id, name: "Renamed" })).name).toBe("Renamed");
    await expect(updateSource({ ownerEmail: ALICE, id: src.id })).rejects.toThrow(/Nothing to update/);
    await expect(updateSource({ ownerEmail: ALICE, id: src.id, name: "  " })).rejects.toThrow(/empty/);
  });

  it("remove deletes the source and everything derived from it, and only that", async () => {
    const keep = await addSource({ ownerEmail: BOB, orgId: null, type: "rss", url: "https://keep.example.com/feed" });
    const doomed = await addSource({ ownerEmail: BOB, orgId: null, type: "rss", url: "https://doomed.example.com/feed" });
    const feed = (host: string) => `<rss version="2.0"><channel><item><title>T ${host}</title><link>https://${host}/1</link></item></channel></rss>`;
    const fetchFor = (host: string) => async (url: string) => ({ text: feed(host), status: 200, contentType: "", finalUrl: url });
    await ingestSource({ ownerEmail: BOB, sourceId: keep.id, fetchText: fetchFor("keep.example.com") });
    await ingestSource({ ownerEmail: BOB, sourceId: doomed.id, fetchText: fetchFor("doomed.example.com") });

    const [doomedItem] = await getDb().select().from(schema.items).where(eq(schema.items.sourceId, doomed.id));
    await getDb().insert(schema.summaries).values({ id: crypto.randomUUID(), ownerEmail: BOB, itemId: doomedItem.id, summaryText: "s" });
    await getDb().insert(schema.scores).values({ id: crypto.randomUUID(), ownerEmail: BOB, itemId: doomedItem.id, relevance: 1, importance: 1, reason: "r" });

    expect((await listSources(BOB)).find((s) => s.id === keep.id)?.itemCount).toBe(1);
    expect(await removeSource(BOB, doomed.id)).toEqual({ removedItems: 1 });

    expect((await listSources(BOB)).map((s) => s.id)).toEqual([keep.id]);
    expect(await getDb().select().from(schema.items).where(eq(schema.items.sourceId, doomed.id))).toHaveLength(0);
    expect(await getDb().select().from(schema.summaries).where(eq(schema.summaries.itemId, doomedItem.id))).toHaveLength(0);
    expect(await getDb().select().from(schema.scores).where(eq(schema.scores.itemId, doomedItem.id))).toHaveLength(0);
    expect(await getDb().select().from(schema.runs).where(eq(schema.runs.sourceId, doomed.id))).toHaveLength(0);
    expect(await getDb().select().from(schema.items).where(eq(schema.items.sourceId, keep.id))).toHaveLength(1);
  });
});
