import { describe, expect, it } from "vitest";
import { feedConnector, parseFeed } from "../connectors/feed.js";
import { hnConnector, mapHnItem } from "../connectors/hn.js";
import { getConnector } from "../connectors/index.js";
import type { ConnectorContext, SourceRow } from "../connectors/types.js";

const RSS = `<?xml version="1.0"?>
<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/"><channel><title>Blog</title>
  <item><title>First &amp; best</title><link>https://example.com/a</link><guid>post-a</guid>
    <pubDate>Mon, 06 Oct 2025 12:00:00 GMT</pubDate><dc:creator>Ada</dc:creator>
    <comments>https://example.com/a#comments</comments></item>
  <item><title>No link here</title></item>
  <item><title>Bad scheme</title><link>javascript:alert(1)</link></item>
  <item><title>Second</title><link>https://example.com/b</link></item>
</channel></rss>`;

const ATOM = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom"><title>A</title>
  <entry><title type="html">Atom post</title>
    <link rel="self" href="https://example.com/self"/>
    <link rel="alternate" href="https://example.com/atom-1"/>
    <id>urn:uuid:1</id><updated>2025-10-05T10:00:00Z</updated><author><name>Grace</name></author></entry>
</feed>`;

describe("parseFeed", () => {
  it("parses RSS, skipping items without a safe http(s) link", () => {
    const items = parseFeed(RSS);
    expect(items.map((i) => i.title)).toEqual(["First & best", "Second"]);
    expect(items[0]).toMatchObject({
      externalId: "post-a",
      url: "https://example.com/a",
      discussionUrl: "https://example.com/a#comments",
      author: "Ada",
      postedAt: "2025-10-06T12:00:00.000Z",
    });
    expect(items[1].externalId).toBe("https://example.com/b"); // falls back to the URL
  });

  it("parses Atom, preferring the alternate link", () => {
    const [item] = parseFeed(ATOM);
    expect(item).toMatchObject({
      externalId: "urn:uuid:1",
      url: "https://example.com/atom-1",
      author: "Grace",
      postedAt: "2025-10-05T10:00:00.000Z",
    });
  });

  it("throws on content that is not a feed (e.g. an HTML error page)", () => {
    expect(() => parseFeed("<html><body>Not found</body></html>")).toThrow(/RSS or Atom/);
  });
});

const source = (over: Partial<SourceRow>): SourceRow =>
  ({
    id: "s1", ownerEmail: "a@example.com", orgId: null, type: "rss", connector: "feed", name: "Test",
    config: "{}", enabled: true, origin: "user", status: "approved", trustWeight: 1,
    discoveryReason: null, discoveredAt: null, lastSuccessAt: null, errorCount: 0, lastError: null,
    createdAt: "", ...over,
  }) as SourceRow;

const ctxWith = (fetchText: ConnectorContext["fetchText"]): ConnectorContext => ({
  fetchText,
  policy: { allowlist: [], denylist: [] },
});

describe("feed connector", () => {
  it("fetches config.url and parses it", async () => {
    const seen: string[] = [];
    const items = await feedConnector.fetchItems(
      source({ config: JSON.stringify({ url: "https://example.com/feed.xml" }) }),
      ctxWith(async (url) => (seen.push(url), { text: RSS, status: 200, contentType: "", finalUrl: url })),
    );
    expect(seen).toEqual(["https://example.com/feed.xml"]);
    expect(items).toHaveLength(2);
  });

  it("fails clearly when the source has no url", async () => {
    await expect(feedConnector.fetchItems(source({ config: "{}" }), ctxWith(async () => { throw new Error("unused"); }))).rejects.toThrow(/config\.url/);
  });
});

describe("hn connector", () => {
  it("maps stories and drops dead, deleted, and non-story items", () => {
    expect(mapHnItem({ id: 1, type: "story", title: "T", url: "https://x.test/", by: "u", time: 1759752000, score: 10, descendants: 3 })).toMatchObject({
      externalId: "1", url: "https://x.test/", discussionUrl: "https://news.ycombinator.com/item?id=1",
      metrics: { points: 10, comments: 3 },
    });
    expect(mapHnItem({ id: 2, type: "story", title: "Ask HN" })?.url).toBe("https://news.ycombinator.com/item?id=2");
    expect(mapHnItem({ id: 3, type: "job", title: "Hiring" })).toBeNull();
    expect(mapHnItem({ id: 4, type: "story", title: "x", dead: true })).toBeNull();
  });

  it("fetches top stories up to the limit and tolerates a failing item", async () => {
    const fetchText: ConnectorContext["fetchText"] = async (url) => {
      const body = url.endsWith("/topstories.json")
        ? [11, 12, 13, 14]
        : url.endsWith("/item/12.json")
          ? (() => { throw new Error("boom"); })()
          : { id: Number(url.match(/item\/(\d+)/)![1]), type: "story", title: `Story ${url}` };
      return { text: JSON.stringify(body), status: 200, contentType: "", finalUrl: url };
    };
    const items = await hnConnector.fetchItems(
      source({ type: "hn", connector: "api", config: JSON.stringify({ limit: 3 }) }),
      ctxWith(fetchText),
    );
    expect(items.map((i) => i.externalId)).toEqual(["11", "13"]); // limit 3 -> 11,12,13; 12 failed
  });
});

describe("getConnector", () => {
  it("routes by connector, and refuses unimplemented ones", () => {
    expect(getConnector(source({ connector: "feed" }))).toBe(feedConnector);
    expect(getConnector(source({ connector: "api", type: "hn" }))).toBe(hnConnector);
    expect(() => getConnector(source({ connector: "mcp" }))).toThrow(/not implemented/);
    expect(() => getConnector(source({ connector: "scrape" }))).toThrow(/not implemented/);
  });
});
