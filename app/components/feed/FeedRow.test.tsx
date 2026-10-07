import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import messages from "@/i18n/en-US";
import type { FeedItem } from "./FeedRow";

/** Resolve "feed.points" style keys against the real English messages, filling {{placeholders}}. */
function translate(key: string, options?: Record<string, unknown>): string {
  const value = key.split(".").reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], messages);
  if (typeof value !== "string") throw new Error(`Missing translation: ${key}`);
  return value.replace(/\{\{(\w+)\}\}/g, (_, name) => {
    if (!options || !(name in options)) throw new Error(`Missing value "${name}" for ${key}`);
    return String(options[name]);
  });
}

vi.mock("@agent-native/core/client/i18n", () => ({ useT: () => translate }));

const { FeedRow, safeHref } = await import("./FeedRow");

const item: FeedItem = {
  id: "i1",
  title: "Write Like It's 1866 & <b>more</b>",
  url: "https://www.example.com/post",
  discussionUrl: "https://news.ycombinator.com/item?id=1",
  imageUrl: "https://cdn.example.com/t.jpg",
  author: "ada",
  postedAt: new Date(Date.now() - 3 * 3_600_000).toISOString(),
  source: { id: "s1", name: "Hacker News", type: "hn", origin: "user" },
  summary: { text: "A short summary.", citationCount: 2, articleUnreadable: false },
  relevance: 85,
  importance: 42,
  reason: "Covers edge rendering. Matched: web development. Buzz: 51 points.",
  metrics: { points: 51, comments: 14 },
};
const html = (over: Partial<FeedItem> = {}, props: { defaultOpen?: boolean } = {}) =>
  renderToStaticMarkup(<FeedRow item={{ ...item, ...over }} rank={3} {...props} />);

describe("FeedRow", () => {
  it("is compact by default: rank, relevance, title link, domain, and one meta line, with the summary hidden", () => {
    const out = html();
    expect(out).toContain(">3<"); // rank
    expect(out).toContain(">85<"); // relevance
    expect(out).toContain('aria-label="Relevance 85"');
    expect(out).toContain('href="https://www.example.com/post"');
    expect(out).toContain("(example.com)");
    expect(out).toContain("Hacker News");
    expect(out).toContain("by ada");
    expect(out).toContain("51 points");
    expect(out).toContain("14 comments");
    expect(out).toContain('href="https://news.ycombinator.com/item?id=1"');
    expect(out).toContain("importance 42");
    expect(out).toContain('aria-expanded="false"');
    expect(out).not.toContain("A short summary.");
    expect(out).not.toContain("Why this score");
  });

  it("keeps the reason one hover away even while collapsed (never a bare number)", () => {
    expect(html()).toContain(`title="${item.reason}"`);
  });

  it("opens to the summary, the why, and the citation count", () => {
    const out = html({}, { defaultOpen: true });
    expect(out).toContain('aria-expanded="true"');
    expect(out).toContain("A short summary.");
    expect(out).toContain("Why this score");
    expect(out).toContain(item.reason);
    expect(out).toContain("2 cited passages");
  });

  it("shows a thumbnail that loads lazily without leaking the referrer, or a placeholder when there is none", () => {
    const withImage = html();
    expect(withImage).toContain('src="https://cdn.example.com/t.jpg"');
    expect(withImage).toMatch(/referrerpolicy="no-referrer"/i);
    expect(withImage).toContain('loading="lazy"');
    const without = html({ imageUrl: null });
    expect(without).not.toContain("<img");
    expect(without).toContain("<svg");
  });

  it("never renders an unsafe image or link, and escapes markup in titles", () => {
    expect(html({ imageUrl: "javascript:alert(1)" })).not.toContain("<img");
    expect(html({ imageUrl: "http://cdn.example.com/insecure.jpg" })).not.toContain("<img");
    const bad = html({ url: "javascript:alert(1)", discussionUrl: "data:text/html,x" });
    expect(bad).not.toContain("javascript:");
    expect(bad).not.toContain("data:text");
    const out = html();
    expect(out).toContain("&lt;b&gt;more&lt;/b&gt;");
    expect(out).not.toContain("<b>more</b>");
  });

  it("marks unreadable articles and falls back when a source reports no comments or points", () => {
    const out = html({ summary: { text: "The article couldn't be read: HTTP 403.", citationCount: 0, articleUnreadable: true }, metrics: {} });
    expect(out).toContain("Article couldn&#x27;t be read");
    expect(out).toContain(">Discussion<");
    expect(out).not.toMatch(/<span>\d+ points<\/span>/); // the reason text in the tooltip may still mention points
  });
});

describe("safeHref", () => {
  it("allows only http(s)", () => {
    expect(safeHref("https://a.example.com/x")).toBe("https://a.example.com/x");
    expect(safeHref("http://a.example.com/x")).toBe("http://a.example.com/x");
    for (const bad of ["javascript:alert(1)", "data:text/html,x", "file:///etc/passwd", "nope", "", null, undefined]) {
      expect(safeHref(bad as string | null | undefined)).toBeUndefined();
    }
  });
});
