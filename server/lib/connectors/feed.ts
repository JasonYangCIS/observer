import { XMLParser } from "fast-xml-parser";
import { safeImageUrl } from "../image-url.js";
import type { Connector, NormalizedItem } from "./types.js";

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

/** The object-valued children of a parsed XML node (a single child or a list). */
function records(node: unknown): Record<string, unknown>[] {
  return asArray(node as unknown).filter((x): x is Record<string, unknown> => !!x && typeof x === "object");
}

function isImageNode(node: Record<string, unknown>): boolean {
  const type = text(node["@_type"]) ?? "";
  const medium = text(node["@_medium"]) ?? "";
  return type.startsWith("image/") || medium === "image" || (!type && !medium);
}

/** First usable thumbnail on an RSS item or Atom entry (media:thumbnail, media:content, enclosure, link enclosure). */
function entryImage(entry: Record<string, unknown>, base: string): string | undefined {
  const candidates: (string | undefined)[] = records(entry["media:thumbnail"]).map((n) => text(n["@_url"]));
  for (const key of ["media:content", "enclosure"]) {
    for (const node of records(entry[key])) {
      if (isImageNode(node)) candidates.push(text(node["@_url"]));
    }
  }
  for (const link of records(entry.link)) {
    if (text(link["@_rel"]) === "enclosure" && (text(link["@_type"]) ?? "").startsWith("image/")) {
      candidates.push(text(link["@_href"]));
    }
  }
  for (const candidate of candidates) {
    const safe = safeImageUrl(candidate, base);
    if (safe) return safe;
  }
  return undefined;
}

/** Parse RSS 2.0 or Atom 1.0 into normalized items. Throws on unrecognized XML. */
export function parseFeed(xml: string): NormalizedItem[] {
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
        imageUrl: entryImage(it, url),
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
      out.push({
        externalId: text(e.id) ?? url,
        url,
        title,
        author: text(e.author?.name),
        postedAt: toIso(e.published) ?? toIso(e.updated),
        imageUrl: entryImage(e, url),
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
    return parseFeed(res.text);
  },
};
