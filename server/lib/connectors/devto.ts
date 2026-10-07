import type { Connector, NormalizedItem } from "./types.js";
import { configLimit, count, fetchJson, isHttpUrl, readConfig, toIsoDate } from "./util.js";

interface DevtoArticle {
  id?: number;
  title?: string;
  url?: string;
  public_reactions_count?: number;
  comments_count?: number;
  published_at?: string;
  user?: { username?: string; name?: string };
}

/** Map one dev.to article. Reactions count as points. */
export function mapDevtoArticle(raw: DevtoArticle): NormalizedItem | null {
  if (!raw || !Number.isInteger(raw.id) || typeof raw.title !== "string" || !raw.title || !isHttpUrl(raw.url)) return null;
  return {
    externalId: String(raw.id),
    url: raw.url,
    discussionUrl: `${raw.url}#comments`,
    title: raw.title.trim(),
    author: raw.user?.username || raw.user?.name || undefined,
    postedAt: toIsoDate(raw.published_at),
    metrics: { points: count(raw.public_reactions_count), comments: count(raw.comments_count) },
  };
}

/** Top dev.to articles of the past week, optionally for one tag (public API). */
export const devtoConnector: Connector = {
  async fetchItems(source, ctx) {
    const limit = configLimit(source.config, 25, 50);
    const tag = readConfig(source.config).tag;
    const query = new URLSearchParams({ top: "7", per_page: String(limit) });
    if (typeof tag === "string" && /^[a-z0-9]{1,30}$/.test(tag)) query.set("tag", tag);
    const data = await fetchJson(ctx, `https://dev.to/api/articles?${query}`);
    if (!Array.isArray(data)) throw new Error("Unexpected dev.to response");
    return data.map((a) => mapDevtoArticle(a as DevtoArticle)).filter((i): i is NormalizedItem => i !== null);
  },
};
