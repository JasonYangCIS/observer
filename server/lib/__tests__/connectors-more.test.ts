import { describe, expect, it } from "vitest";
import { getConnector } from "../connectors/index.js";
import { mapDevtoArticle, devtoConnector } from "../connectors/devto.js";
import { feedConnector, parseFeed, redditExternalLink } from "../connectors/feed.js";
import { githubConnector, mapGithubRepo } from "../connectors/github.js";
import { lobstersConnector, mapLobstersStory } from "../connectors/lobsters.js";
import type { ConnectorContext, SourceRow } from "../connectors/types.js";
import { configLimit, count, isHttpUrl, toIsoDate } from "../connectors/util.js";

const source = (over: Partial<SourceRow>): SourceRow =>
  ({
    id: "s1", ownerEmail: "a@example.com", orgId: null, type: "lobsters", connector: "api", name: "Test", config: "{}",
    enabled: true, origin: "user", status: "approved", trustWeight: 1, discoveryReason: null, discoveredAt: null,
    lastSuccessAt: null, errorCount: 0, lastError: null, createdAt: "", ...over,
  }) as SourceRow;

/** A context whose fetchText returns `body` and records the URLs asked for. */
function ctxReturning(body: unknown, seen: string[] = []): ConnectorContext {
  return {
    policy: { allowlist: [], denylist: [] },
    fetchText: async (url) => {
      seen.push(url);
      return { text: typeof body === "string" ? body : JSON.stringify(body), status: 200, contentType: "", finalUrl: url };
    },
  };
}

describe("util", () => {
  it("validates links, limits, dates, and counts from untrusted data", () => {
    expect(isHttpUrl("https://a.example.com/x")).toBe(true);
    for (const bad of ["javascript:alert(1)", "data:text/html,x", "not a url", "", null, 12]) expect(isHttpUrl(bad)).toBe(false);
    expect(configLimit('{"limit":5}', 25, 50)).toBe(5);
    expect(configLimit('{"limit":500}', 25, 50)).toBe(50);
    for (const raw of ["{}", "garbage", '{"limit":"x"}', '{"limit":-3}']) expect(configLimit(raw, 25, 50)).toBe(25);
    expect(toIsoDate("2026-10-07T08:09:33.721-05:00")).toBe("2026-10-07T13:09:33.721Z");
    expect(toIsoDate("nope")).toBeUndefined();
    expect([count(41.9), count(-1), count("5"), count(NaN), count(undefined)]).toEqual([41, 0, 0, 0, 0]);
  });
});

describe("lobsters", () => {
  const story = { short_id: "rwdufq", created_at: "2026-10-07T08:09:33.721-05:00", title: " Anti-Patterns in Software Blogging ", url: "https://refactoringenglish.com/blog/anti-patterns-software-blogging/", score: 66, comment_count: 31, submitter_user: "mtlynch", comments_url: "https://lobste.rs/s/rwdufq/anti_patterns_software_blogging" };

  it("maps a story with points, comments, a discussion link, and an ISO date", () => {
    expect(mapLobstersStory(story)).toEqual({
      externalId: "rwdufq", url: story.url, discussionUrl: story.comments_url, title: "Anti-Patterns in Software Blogging",
      author: "mtlynch", postedAt: "2026-10-07T13:09:33.721Z", metrics: { points: 66, comments: 31 },
    });
  });

  it("points text-only posts at their thread, accepts an object submitter, and drops malformed or unsafe entries", () => {
    expect(mapLobstersStory({ ...story, url: "" })?.url).toBe(story.comments_url);
    expect(mapLobstersStory({ ...story, url: "javascript:alert(1)" })?.url).toBe(story.comments_url);
    expect(mapLobstersStory({ ...story, submitter_user: { username: "ada" } })?.author).toBe("ada");
    expect(mapLobstersStory({ ...story, comments_url: undefined })?.discussionUrl).toBe("https://lobste.rs/s/rwdufq");
    expect(mapLobstersStory({ ...story, title: "" })).toBeNull();
    expect(mapLobstersStory({ ...story, short_id: undefined })).toBeNull();
    expect(mapLobstersStory({ ...story, score: -4, comment_count: undefined })?.metrics).toEqual({ points: 0, comments: 0 });
  });

  it("fetches the hottest list, honors the limit, and rejects a non-list response", async () => {
    const seen: string[] = [];
    const many = Array.from({ length: 30 }, (_, i) => ({ ...story, short_id: `s${i}` }));
    expect(await lobstersConnector.fetchItems(source({ config: '{"limit":3}' }), ctxReturning(many, seen))).toHaveLength(3);
    expect(seen).toEqual(["https://lobste.rs/hottest.json"]);
    await expect(lobstersConnector.fetchItems(source({}), ctxReturning({ error: "x" }))).rejects.toThrow(/Unexpected Lobsters/);
    await expect(lobstersConnector.fetchItems(source({}), ctxReturning("<html>"))).rejects.toThrow(/isn't JSON/);
  });
});

describe("dev.to", () => {
  const article = { id: 4810584, title: "I Think We're Forgetting How to Be Bored", url: "https://dev.to/james_anderson_h/i-think-were-forgetting-how-to-be-bored-1abc", public_reactions_count: 39, comments_count: 11, published_at: "2026-10-07T06:59:26Z", user: { username: "james_anderson_h", name: "James Anderson" } };

  it("maps reactions to points and links the comments section", () => {
    expect(mapDevtoArticle(article)).toEqual({
      externalId: "4810584", url: article.url, discussionUrl: `${article.url}#comments`, title: article.title,
      author: "james_anderson_h", postedAt: "2026-10-07T06:59:26.000Z", metrics: { points: 39, comments: 11 },
    });
    expect(mapDevtoArticle({ ...article, url: "javascript:alert(1)" })).toBeNull();
    expect(mapDevtoArticle({ ...article, id: undefined })).toBeNull();
  });

  it("asks for the week's top articles, adds a valid tag, and ignores a malformed one", async () => {
    const seen: string[] = [];
    await devtoConnector.fetchItems(source({ type: "devto", config: JSON.stringify({ tag: "webdev", limit: 10 }) }), ctxReturning([article], seen));
    await devtoConnector.fetchItems(source({ type: "devto", config: JSON.stringify({ tag: "Bad Tag&x=1" }) }), ctxReturning([article], seen));
    expect(seen[0]).toBe("https://dev.to/api/articles?top=7&per_page=10&tag=webdev");
    expect(seen[1]).toBe("https://dev.to/api/articles?top=7&per_page=25");
    await expect(devtoConnector.fetchItems(source({ type: "devto" }), ctxReturning({}))).rejects.toThrow(/Unexpected dev.to/);
  });
});

describe("github", () => {
  const repo = { id: 1234, full_name: "octo/widgets", description: "  A fast\n widget  library ", html_url: "https://github.com/octo/widgets", stargazers_count: 812, created_at: "2026-10-04T10:00:00Z", owner: { login: "octo" } };

  it("maps stars to points and folds the description into the title", () => {
    expect(mapGithubRepo(repo)).toEqual({ externalId: "1234", url: repo.html_url, title: "octo/widgets: A fast widget library", author: "octo", postedAt: "2026-10-04T10:00:00.000Z", metrics: { points: 812 } });
    expect(mapGithubRepo({ ...repo, description: null })?.title).toBe("octo/widgets");
    expect(mapGithubRepo({ ...repo, description: "x".repeat(500) })?.title).toHaveLength(200);
    expect(mapGithubRepo({ ...repo, html_url: "javascript:alert(1)" })).toBeNull();
  });

  it("searches recently created repos by stars, with a validated language and window", async () => {
    const seen: string[] = [];
    await githubConnector.fetchItems(source({ type: "github", config: JSON.stringify({ language: "TypeScript", days: 3, limit: 5 }) }), ctxReturning({ items: [repo] }, seen));
    const url = new URL(seen[0]);
    expect(url.origin + url.pathname).toBe("https://api.github.com/search/repositories");
    expect(url.searchParams.get("sort")).toBe("stars");
    expect(url.searchParams.get("order")).toBe("desc");
    expect(url.searchParams.get("per_page")).toBe("5");
    const q = url.searchParams.get("q")!;
    expect(q).toMatch(/^created:>\d{4}-\d{2}-\d{2} language:TypeScript$/);
    const sinceMs = Date.parse(q.match(/created:>(\S+)/)![1]);
    expect(Date.now() - sinceMs).toBeGreaterThan(2 * 86_400_000);
    expect(Date.now() - sinceMs).toBeLessThan(4 * 86_400_000);

    await githubConnector.fetchItems(source({ type: "github", config: JSON.stringify({ language: "a b&q=1", days: 999 }) }), ctxReturning({ items: [] }, seen));
    expect(new URL(seen[1]).searchParams.get("q")).toMatch(/^created:>\d{4}-\d{2}-\d{2}$/); // bad language ignored
    await expect(githubConnector.fetchItems(source({ type: "github" }), ctxReturning({ message: "rate limited" }))).rejects.toThrow(/Unexpected GitHub/);
  });
});

describe("reddit via the feed connector", () => {
  // A real r/programming entry (trimmed): the HTML in <content> is entity-escaped.
  const entry = (link: string) => `<entry><author><name>/u/mtlynch</name></author><category term="programming" label="r/programming"/><content type="html">&amp;#32; submitted by &amp;#32; &lt;a href=&quot;https://www.reddit.com/user/mtlynch&quot;&gt; /u/mtlynch &lt;/a&gt; &lt;br/&gt; &lt;span&gt;&lt;a href=&quot;${link}&quot;&gt;[link]&lt;/a&gt;&lt;/span&gt; &amp;#32; &lt;span&gt;&lt;a href=&quot;https://www.reddit.com/r/programming/comments/1wzw4cw/x/&quot;&gt;[comments]&lt;/a&gt;&lt;/span&gt;</content><id>t3_1wzw4cw</id><link href="https://www.reddit.com/r/programming/comments/1wzw4cw/x/" /><published>2026-10-07T13:10:04+00:00</published><title>Anti-Patterns in Software Blogging</title></entry>`;
  const feed = (link: string) => `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">${entry(link)}</feed>`;

  it("uses the linked article as the URL and the Reddit thread as the discussion", () => {
    const [item] = parseFeed(feed("https://refactoringenglish.com/blog/anti-patterns-software-blogging/"), { reddit: true });
    expect(item).toMatchObject({
      externalId: "t3_1wzw4cw", url: "https://refactoringenglish.com/blog/anti-patterns-software-blogging/",
      discussionUrl: "https://www.reddit.com/r/programming/comments/1wzw4cw/x/", author: "/u/mtlynch", postedAt: "2026-10-07T13:10:04.000Z",
    });
  });

  it("keeps the thread for self posts and Reddit-hosted links, and for non-Reddit sources", () => {
    const thread = "https://www.reddit.com/r/programming/comments/1wzw4cw/x/";
    expect(parseFeed(feed("https://www.reddit.com/r/programming/comments/1wzw4cw/x/"), { reddit: true })[0]).toMatchObject({ url: thread });
    expect(parseFeed(feed("https://i.redd.it/abc.jpg"), { reddit: true })[0].url).toBe(thread);
    expect(parseFeed(feed("https://example.com/a"))[0].url).toBe(thread); // only reddit sources get this treatment
    expect(parseFeed(feed("javascript:alert(1)"), { reddit: true })[0].url).toBe(thread);
  });

  it("decodes &amp; in the linked URL and handles missing content", () => {
    expect(redditExternalLink('<a href="https://example.com/a?x=1&amp;y=2">[link]</a>')).toBe("https://example.com/a?x=1&y=2");
    expect(redditExternalLink(undefined)).toBeUndefined();
    expect(redditExternalLink("<p>no link anchor</p>")).toBeUndefined();
  });

  it("only the reddit source type triggers it when fetching", async () => {
    const xml = feed("https://refactoringenglish.com/blog/anti-patterns-software-blogging/");
    const cfg = JSON.stringify({ url: "https://www.reddit.com/r/programming/.rss" });
    const asReddit = await feedConnector.fetchItems(source({ type: "reddit", connector: "feed", config: cfg }), ctxReturning(xml));
    const asRss = await feedConnector.fetchItems(source({ type: "rss", connector: "feed", config: cfg }), ctxReturning(xml));
    expect(asReddit[0].url).toContain("refactoringenglish.com");
    expect(asRss[0].url).toContain("reddit.com");
  });
});

describe("getConnector", () => {
  it("routes every API source type, sends feed-based types to the feed connector, and rejects unknown ones", () => {
    expect(getConnector(source({ type: "lobsters", connector: "api" }))).toBe(lobstersConnector);
    expect(getConnector(source({ type: "devto", connector: "api" }))).toBe(devtoConnector);
    expect(getConnector(source({ type: "github", connector: "api" }))).toBe(githubConnector);
    for (const type of ["rss", "reddit", "producthunt"]) expect(getConnector(source({ type, connector: "feed" }))).toBe(feedConnector);
    expect(() => getConnector(source({ type: "mastodon", connector: "api" }))).toThrow(/No API connector/);
  });
});
