import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const dir = mkdtempSync(join(tmpdir(), "observer-source-types-"));
process.env.DATABASE_URL = `pglite:${join(dir, "db")}`;

const { runMigrations, closeDbExec } = await import("@agent-native/core/db");
const { APP_MIGRATIONS, APP_MIGRATIONS_TABLE } = await import("../../db/migrations.js");
const { getDb, schema } = await import("../../db/index.js");
const { MAX_SOURCES, addSource, draftSource, importOpml, listSources, parseOpml } = await import("../sources.js");
const { eq } = await import("drizzle-orm");

const add = (args: Record<string, unknown>, owner = "alice@example.com") =>
  addSource({ ownerEmail: owner, orgId: null, ...args } as Parameters<typeof addSource>[0]);

beforeAll(async () => {
  await runMigrations(APP_MIGRATIONS, { table: APP_MIGRATIONS_TABLE })(null);
});
afterAll(async () => {
  await closeDbExec();
  rmSync(dir, { recursive: true, force: true });
});

describe("draftSource", () => {
  it("builds each source type with the right connector, config, and name", () => {
    expect(draftSource({ type: "lobsters" })).toMatchObject({ connector: "api", name: "Lobsters", config: {} });
    expect(draftSource({ type: "producthunt" })).toMatchObject({ connector: "feed", config: { url: "https://www.producthunt.com/feed" } });
    expect(draftSource({ type: "devto", tag: "#WebDev", limit: 10 })).toMatchObject({ name: "dev.to #webdev", config: { limit: 10, tag: "webdev" } });
    expect(draftSource({ type: "github", language: "TypeScript" })).toMatchObject({ name: "GitHub new repos (TypeScript)", config: { language: "TypeScript" } });
    expect(draftSource({ type: "reddit", subreddit: "r/programming" })).toMatchObject({ connector: "feed", name: "r/programming", config: { url: "https://www.reddit.com/r/programming/.rss" } });
    expect(draftSource({ type: "rss", url: "https://blog.example.com/feed.xml#x" })).toMatchObject({ name: "blog.example.com", config: { url: "https://blog.example.com/feed.xml" } });
  });

  it("rejects anything that could change where a fetch goes", () => {
    for (const subreddit of ["", "a", "x".repeat(22), "../etc", "prog ramming", "prog/ramming", "a?b=1", "evil.com/x"]) {
      expect(() => draftSource({ type: "reddit", subreddit }), subreddit).toThrow();
    }
    for (const tag of ["web dev", "a&b=1", "x".repeat(31), "é"]) expect(() => draftSource({ type: "devto", tag }), tag).toThrow(/letters and numbers/);
    for (const language of ["Type Script", "a&q=1", "x".repeat(31), "../"]) expect(() => draftSource({ type: "github", language }), language).toThrow(/language/);
    expect(() => draftSource({ type: "reddit" })).toThrow(/subreddit name is required/);
    expect(() => draftSource({ type: "rss" })).toThrow(/feed URL is required/);
    expect(() => draftSource({ type: "rss", url: "javascript:alert(1)" })).toThrow();
  });
});

describe("addSource for the new types", () => {
  it("adds one of each, and rejects duplicates by what makes them the same source", async () => {
    const owner = "dupes@example.com";
    for (const args of [{ type: "lobsters" }, { type: "producthunt" }, { type: "devto" }, { type: "devto", tag: "webdev" }, { type: "github" }, { type: "github", language: "Rust" }, { type: "reddit", subreddit: "programming" }]) {
      expect((await add(args, owner)).type).toBe(args.type);
    }
    for (const args of [{ type: "lobsters" }, { type: "producthunt" }, { type: "devto" }, { type: "devto", tag: "WebDev" }, { type: "github" }, { type: "github", language: "rust" }, { type: "reddit", subreddit: "Programming" }, { type: "reddit", subreddit: "r/programming" }]) {
      await expect(add(args, owner), JSON.stringify(args)).rejects.toThrow(/already added/);
    }
    await add({ type: "reddit", subreddit: "webdev" }, owner); // a different subreddit is fine
    expect((await listSources(owner)).map((s) => s.type).sort()).toEqual(["devto", "devto", "github", "github", "lobsters", "producthunt", "reddit", "reddit"]);
  });

  it("caps the number of sources per user", async () => {
    const owner = "cap@example.com";
    for (let i = 0; i < MAX_SOURCES; i++) await add({ type: "rss", url: `https://site${i}.example.com/feed` }, owner);
    await expect(add({ type: "rss", url: "https://one-too-many.example.com/feed" }, owner)).rejects.toThrow(/up to 50 sources/);
    expect(await getDb().select().from(schema.sources).where(eq(schema.sources.ownerEmail, owner))).toHaveLength(MAX_SOURCES);
  });
});

const OPML = (body: string) => `<?xml version="1.0"?><opml version="2.0"><head><title>My feeds</title></head><body>${body}</body></opml>`;

describe("OPML import", () => {
  it("reads nested outlines, titles, and ignores folders and outlines with no feed", () => {
    const feeds = parseOpml(OPML(`
      <outline text="Tech" title="Tech">
        <outline type="rss" text="Blog A" title="Blog A" xmlUrl="https://a.example.com/feed.xml" htmlUrl="https://a.example.com"/>
        <outline type="rss" text="Blog B" xmlUrl="https://b.example.com/rss"/>
        <outline text="Deep"><outline type="rss" title="Blog C" xmlUrl="https://c.example.com/atom.xml"/></outline>
      </outline>
      <outline text="No feed here"/>`));
    expect(feeds).toEqual([
      { url: "https://a.example.com/feed.xml", title: "Blog A" },
      { url: "https://b.example.com/rss", title: "Blog B" },
      { url: "https://c.example.com/atom.xml", title: "Blog C" },
    ]);
  });

  it("rejects text that isn't OPML", () => {
    expect(() => parseOpml("<html><body>hi</body></html>")).toThrow(/isn't valid OPML/);
    expect(() => parseOpml("")).toThrow(/isn't valid OPML/);
  });

  it("adds feeds, skipping duplicates, unsafe links, and what's over the cap, and reports each count", async () => {
    const owner = "opml@example.com";
    await add({ type: "rss", url: "https://dupe.example.com/feed" }, owner);
    const result = await importOpml({
      ownerEmail: owner, orgId: null,
      opml: OPML(`
        <outline type="rss" title="New One" xmlUrl="https://new1.example.com/feed"/>
        <outline type="rss" title="Dupe" xmlUrl="https://dupe.example.com/feed"/>
        <outline type="rss" title="Again" xmlUrl="https://new1.example.com/feed"/>
        <outline type="rss" title="Bad" xmlUrl="javascript:alert(1)"/>
        <outline type="rss" title="Local" xmlUrl="file:///etc/passwd"/>
        <outline type="rss" xmlUrl="https://new2.example.com/feed"/>`),
    });
    expect(result).toEqual({ added: 2, skippedDuplicate: 2, skippedInvalid: 2, skippedOverLimit: 0, addedNames: ["New One", "new2.example.com"] });
    const rows = await getDb().select().from(schema.sources).where(eq(schema.sources.ownerEmail, owner));
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.origin === "user" && r.status === "approved")).toBe(true);
  });

  it("stops at the source cap instead of failing", async () => {
    const owner = "opml-cap@example.com";
    for (let i = 0; i < MAX_SOURCES - 2; i++) await add({ type: "rss", url: `https://s${i}.example.com/feed` }, owner);
    const feeds = Array.from({ length: 5 }, (_, i) => `<outline type="rss" xmlUrl="https://extra${i}.example.com/feed"/>`).join("");
    expect(await importOpml({ ownerEmail: owner, orgId: null, opml: OPML(feeds) })).toMatchObject({ added: 2, skippedOverLimit: 3 });
    expect(await getDb().select().from(schema.sources).where(eq(schema.sources.ownerEmail, owner))).toHaveLength(MAX_SOURCES);
  });

  it("is scoped to the owner", async () => {
    const opml = OPML('<outline type="rss" xmlUrl="https://shared.example.com/feed"/>');
    expect((await importOpml({ ownerEmail: "one@example.com", orgId: null, opml })).added).toBe(1);
    expect((await importOpml({ ownerEmail: "two@example.com", orgId: null, opml })).added).toBe(1);
  });
});
