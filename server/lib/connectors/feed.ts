import { XMLParser } from "fast-xml-parser";
import type { Connector, NormalizedItem } from "./types.js";
import { isHttpUrl } from "./util.js";

const MAX_ITEMS = 100;

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
  processEntities: true,
});

function asArray<T>(v: T | T[] | undefined): T[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

function text(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === "string" || typeof v === "number") {
    const s = String(v).trim();
    return s || undefined;
  }
  if (typeof v === "object" && "#text" in (v as object)) {
    return text((v as Record<string, unknown>)["#text"]);
  }
  return undefined;
}

function toIso(v: unknown): string | undefined {
  const s = text(v);
  if (!s) return undefined;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

function atomLink(links: unknown): string | undefined {
  const list = asArray(links as Record<string, unknown> | string | undefined);
  let fallback: string | undefined;
  for (const l of list) {
    if (typeof l === "string") return l;
    const attrs = l as Record<string, unknown>;
    const href = text(attrs["@_href"]);
    if (!href) continue;
    const rel = text(attrs["@_rel"]);
    if (!rel || rel === "alternate") return href;
    fallback ??= href;
  }
  return fallback;
}

function httpUrl(u: string | undefined): string | undefined {
  if (!u) return undefined;
  try {
    const p = new URL(u);
    return p.protocol === "http:" || p.protocol === "https:" ? p.toString() : undefined;
  } catch {
    return undefined;
  }
}

const REDDIT_HOST = /(^|\.)(reddit\.com|redd\.it)$/i;

/**
 * The article a Reddit post links to, from the "[link]" anchor in the entry's HTML
 * content. Self posts and Reddit-hosted media link back to Reddit and return
 * undefined, so those keep the thread as their URL.
 */
export function redditExternalLink(contentHtml: string | undefined): string | undefined {
  const match = contentHtml ? /<a\s+href="([^"]+)">\[link\]<\/a>/.exec(contentHtml) : null;
  if (!match) return undefined;
  const href = match[1].replace(/&amp;/g, "&");
  if (!isHttpUrl(href)) return undefined;
  return REDDIT_HOST.test(new URL(href).hostname) ? undefined : href;
}

export interface ParseFeedOptions {
  /** Reddit Atom feeds: use the linked article as the item URL and the thread as the discussion. */
  reddit?: boolean;
}

/** Parse RSS 2.0 or Atom 1.0 into normalized items. Throws on unrecognized XML. */
export function parseFeed(xml: string, options: ParseFeedOptions = {}): NormalizedItem[] {
  const doc = parser.parse(xml);
  const out: NormalizedItem[] = [];

  if (doc?.rss?.channel) {
    for (const it of asArray(doc.rss.channel.item).slice(0, MAX_ITEMS)) {
      const url = httpUrl(text(it.link));
      const title = text(it.title);
      if (!url || !title) continue;
      out.push({
        externalId: text(it.guid) ?? url,
        url,
        discussionUrl: httpUrl(text(it.comments)),
        title,
        author: text(it["dc:creator"]) ?? text(it.author),
        postedAt: toIso(it.pubDate),
        metrics: {},
      });
    }
    return out;
  }

  if (doc?.feed) {
    for (const e of asArray(doc.feed.entry).slice(0, MAX_ITEMS)) {
      const url = httpUrl(atomLink(e.link));
      const title = text(e.title);
      if (!url || !title) continue;
      const external = options.reddit ? redditExternalLink(text(e.content)) : undefined;
      out.push({
        externalId: text(e.id) ?? url,
        url: external ?? url,
        ...(external ? { discussionUrl: url } : {}),
        title,
        author: text(e.author?.name),
        postedAt: toIso(e.published) ?? toIso(e.updated),
        metrics: {},
      });
    }
    return out;
  }

  throw new Error("Not a recognized RSS or Atom feed");
}

function feedUrl(config: string): string {
  let url: unknown;
  try {
    url = JSON.parse(config)?.url;
  } catch {
    // handled below
  }
  if (typeof url !== "string" || !url) throw new Error("Feed source is missing config.url");
  return url;
}

/** RSS / Atom feed connector. */
export const feedConnector: Connector = {
  async fetchItems(source, ctx) {
    const res = await ctx.fetchText(feedUrl(source.config), {
      accept: "application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.5",
      policy: ctx.policy,
    });
    return parseFeed(res.text, { reddit: source.type === "reddit" });
  },
};
