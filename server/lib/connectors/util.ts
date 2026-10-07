/** True for absolute http(s) URLs. Links come from the open web, so anything else is dropped. */
export function isHttpUrl(value: unknown): value is string {
  if (typeof value !== "string" || !value) return false;
  try {
    const { protocol } = new URL(value);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

/** A source's JSON config as an object; anything unparseable is treated as empty. */
export function readConfig(config: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(config);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** `config.limit` as a whole number between 1 and `max`, or `fallback` when missing or invalid. */
export function configLimit(config: string, fallback: number, max: number): number {
  const n = Number(readConfig(config).limit);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), max) : fallback;
}

/** ISO-8601 for a parseable date string, otherwise undefined. */
export function toIsoDate(value: unknown): string | undefined {
  if (typeof value !== "string" || !value) return undefined;
  const ms = new Date(value).getTime();
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
}

/** A finite, non-negative whole number, otherwise 0. For engagement counts from untrusted JSON. */
export function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/** Fetch and parse a JSON API response, failing with a clear message on bad content. */
export async function fetchJson(ctx: import("./types.js").ConnectorContext, url: string, headers?: { accept?: string }): Promise<unknown> {
  const res = await ctx.fetchText(url, { accept: headers?.accept ?? "application/json", policy: ctx.policy, maxBytes: 1_500_000 });
  try {
    return JSON.parse(res.text);
  } catch {
    throw new Error("The source returned something that isn't JSON.");
  }
}
