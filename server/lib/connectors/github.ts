import type { Connector, NormalizedItem } from "./types.js";
import { configLimit, count, fetchJson, isHttpUrl, readConfig, toIsoDate } from "./util.js";

interface GithubRepo {
  id?: number;
  full_name?: string;
  description?: string | null;
  html_url?: string;
  stargazers_count?: number;
  created_at?: string;
  owner?: { login?: string };
}

/** Map one repository. Stars count as points; the description is part of the title so it can be read in the feed. */
export function mapGithubRepo(raw: GithubRepo): NormalizedItem | null {
  if (!raw || !Number.isInteger(raw.id) || typeof raw.full_name !== "string" || !raw.full_name || !isHttpUrl(raw.html_url)) return null;
  const description = typeof raw.description === "string" ? raw.description.replace(/\s+/g, " ").trim() : "";
  return {
    externalId: String(raw.id),
    url: raw.html_url,
    title: description ? `${raw.full_name}: ${description}`.slice(0, 200) : raw.full_name,
    author: raw.owner?.login || undefined,
    postedAt: toIsoDate(raw.created_at),
    metrics: { points: count(raw.stargazers_count) },
  };
}

/**
 * Popular new GitHub repositories: those created in the last `days` days (default
 * 7), most starred first, optionally for one language. GitHub has no official
 * "trending" API, so this is the closest public equivalent and is labelled as such.
 * Unauthenticated search is limited to 10 requests a minute; one call per fetch.
 */
export const githubConnector: Connector = {
  async fetchItems(source, ctx) {
    const config = readConfig(source.config);
    const days = typeof config.days === "number" && config.days >= 1 && config.days <= 30 ? Math.floor(config.days) : 7;
    const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
    const language = typeof config.language === "string" && /^[A-Za-z0-9+#.-]{1,30}$/.test(config.language) ? config.language : null;
    const q = `created:>${since}${language ? ` language:${language}` : ""}`;
    const query = new URLSearchParams({ q, sort: "stars", order: "desc", per_page: String(configLimit(source.config, 25, 50)) });
    const data = (await fetchJson(ctx, `https://api.github.com/search/repositories?${query}`, { accept: "application/vnd.github+json" })) as { items?: unknown };
    if (!data || !Array.isArray(data.items)) throw new Error("Unexpected GitHub response");
    return data.items.map((r) => mapGithubRepo(r as GithubRepo)).filter((i): i is NormalizedItem => i !== null);
  },
};
