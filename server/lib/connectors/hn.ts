import type { Connector, NormalizedItem } from "./types.js";
import { configLimit, isHttpUrl } from "./util.js";

const HN_API = "https://hacker-news.firebaseio.com/v0";
const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 60;
const CONCURRENCY = 5;

interface HnItem {
  id: number;
  type?: string;
  title?: string;
  url?: string;
  by?: string;
  time?: number;
  score?: number;
  descendants?: number;
  dead?: boolean;
  deleted?: boolean;
}

export function mapHnItem(raw: HnItem): NormalizedItem | null {
  if (!raw || raw.dead || raw.deleted || !raw.title) return null;
  if (raw.type && raw.type !== "story") return null;
  const discussionUrl = `https://news.ycombinator.com/item?id=${raw.id}`;
  return {
    externalId: String(raw.id),
    url: isHttpUrl(raw.url) ? raw.url : discussionUrl,
    discussionUrl,
    title: raw.title,
    author: raw.by,
    postedAt: raw.time ? new Date(raw.time * 1000).toISOString() : undefined,
    metrics: { points: raw.score ?? 0, comments: raw.descendants ?? 0 },
  };
}

/** Hacker News official API (top stories). */
export const hnConnector: Connector = {
  async fetchItems(source, ctx) {
    const get = async (path: string) => {
      const res = await ctx.fetchText(`${HN_API}${path}`, {
        accept: "application/json",
        policy: ctx.policy,
        skipAllowlist: true,
        maxBytes: 200_000,
        minIntervalMs: 50,
      });
      return JSON.parse(res.text);
    };

    const ids: unknown = await get("/topstories.json");
    if (!Array.isArray(ids)) throw new Error("Unexpected Hacker News response");
    const wanted = ids.filter((x): x is number => Number.isInteger(x)).slice(0, configLimit(source.config, DEFAULT_LIMIT, MAX_LIMIT));

    const out: NormalizedItem[] = [];
    for (let i = 0; i < wanted.length; i += CONCURRENCY) {
      const batch = wanted.slice(i, i + CONCURRENCY);
      const rows = await Promise.allSettled(batch.map((id) => get(`/item/${id}.json`)));
      for (const r of rows) {
        if (r.status !== "fulfilled") continue; // one bad item must not fail the run
        const item = mapHnItem(r.value);
        if (item) out.push(item);
      }
    }
    return out;
  },
};
