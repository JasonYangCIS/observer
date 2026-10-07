import type { Connector, NormalizedItem } from "./types.js";
import { configLimit, count, fetchJson, isHttpUrl, toIsoDate } from "./util.js";

const URL_HOTTEST = "https://lobste.rs/hottest.json";

interface LobstersStory {
  short_id?: string;
  title?: string;
  url?: string;
  score?: number;
  comment_count?: number;
  comments_url?: string;
  created_at?: string;
  submitter_user?: string | { username?: string };
}

/** Map one Lobsters story. Text-only posts (no external link) point at their own thread. */
export function mapLobstersStory(raw: LobstersStory): NormalizedItem | null {
  if (!raw || typeof raw.short_id !== "string" || !raw.short_id || typeof raw.title !== "string" || !raw.title) return null;
  const discussionUrl = isHttpUrl(raw.comments_url) ? raw.comments_url : `https://lobste.rs/s/${raw.short_id}`;
  const author = typeof raw.submitter_user === "string" ? raw.submitter_user : raw.submitter_user?.username;
  return {
    externalId: raw.short_id,
    url: isHttpUrl(raw.url) ? raw.url : discussionUrl,
    discussionUrl,
    title: raw.title.trim(),
    author: author || undefined,
    postedAt: toIsoDate(raw.created_at),
    metrics: { points: count(raw.score), comments: count(raw.comment_count) },
  };
}

/** Lobsters "hottest" stories (public JSON). */
export const lobstersConnector: Connector = {
  async fetchItems(source, ctx) {
    const data = await fetchJson(ctx, URL_HOTTEST);
    if (!Array.isArray(data)) throw new Error("Unexpected Lobsters response");
    return data
      .slice(0, configLimit(source.config, 25, 25))
      .map((s) => mapLobstersStory(s as LobstersStory))
      .filter((i): i is NormalizedItem => i !== null);
  },
};
