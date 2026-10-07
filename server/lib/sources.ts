import { randomUUID } from "node:crypto";
import { fail } from "@agent-native/core/action";
import { and, count, eq, inArray } from "drizzle-orm";
import { XMLParser } from "fast-xml-parser";
import { getDb, schema } from "../db/index.js";
import { detachItems } from "./cluster.js";

const { sources, sourceSettings, items, summaries, scores, runs, feedback } = schema;

export const SOURCE_KINDS = ["hn", "rss", "lobsters", "devto", "github", "reddit", "producthunt"] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

/** Most sources one user can have. Each is fetched on every update, so this bounds cost. */
export const MAX_SOURCES = 50;

export interface SourceView {
  id: string;
  name: string;
  type: string;
  connector: string;
  url: string | null;
  limit: number | null;
  enabled: boolean;
  status: string;
  origin: string;
  trustWeight: number;
  lastSuccessAt: string | null;
  errorCount: number;
  lastError: string | null;
  itemCount: number;
  /** ok | failing | never_fetched | stale | mostly_skipped; null until the first health check. */
  healthStatus: string | null;
  healthReason: string | null;
  createdAt: string;
}

function readConfig(config: string): { url?: unknown; limit?: unknown } {
  try {
    const v = JSON.parse(config);
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

function toView(row: typeof sources.$inferSelect, itemCount: number): SourceView {
  const cfg = readConfig(row.config);
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    connector: row.connector,
    url: typeof cfg.url === "string" ? cfg.url : null,
    limit: typeof cfg.limit === "number" ? cfg.limit : null,
    enabled: row.enabled,
    status: row.status,
    origin: row.origin,
    trustWeight: row.trustWeight,
    lastSuccessAt: row.lastSuccessAt,
    errorCount: row.errorCount,
    lastError: row.lastError,
    itemCount,
    healthStatus: row.healthStatus,
    healthReason: row.healthReason,
    createdAt: row.createdAt,
  };
}

export async function listSources(ownerEmail: string): Promise<SourceView[]> {
  const db = getDb();
  const rows = await db.select().from(sources).where(eq(sources.ownerEmail, ownerEmail)).orderBy(sources.createdAt);
  if (rows.length === 0) return [];
  const counts = await db
    .select({ sourceId: items.sourceId, n: count() })
    .from(items)
    .where(and(eq(items.ownerEmail, ownerEmail), inArray(items.sourceId, rows.map((r) => r.id))))
    .groupBy(items.sourceId);
  const byId = new Map(counts.map((c) => [c.sourceId, Number(c.n)]));
  return rows.map((r) => toView(r, byId.get(r.id) ?? 0));
}

/** Validate and canonicalize a user-supplied feed URL (http/https only). */
export function normalizeFeedUrl(input: string): string {
  let parsed: URL;
  try {
    parsed = new URL(input.trim());
  } catch {
    fail("That doesn't look like a valid URL", { errorCode: "invalid_url" });
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    fail("Only http and https URLs are supported", { errorCode: "invalid_url" });
  }
  if (parsed.username || parsed.password) {
    fail("URLs with embedded credentials are not allowed", { errorCode: "invalid_url" });
  }
  parsed.hash = "";
  return parsed.toString();
}

/** Every owner gets a source_settings row; trusted_only is the Phase 1 mode. */
export async function ensureSourceSettings(ownerEmail: string, orgId: string | null): Promise<void> {
  await getDb()
    .insert(sourceSettings)
    .values({ id: randomUUID(), ownerEmail, orgId })
    .onConflictDoNothing({ target: sourceSettings.ownerEmail });
}

export interface AddSourceArgs {
  ownerEmail: string;
  orgId: string | null;
  type: SourceKind;
  name?: string;
  /** Feed URL, for type "rss". */
  url?: string;
  /** Stories or items per fetch, for the API sources. */
  limit?: number;
  /** Subreddit name without "r/", for type "reddit". */
  subreddit?: string;
  /** dev.to tag, for type "devto" (optional). */
  tag?: string;
  /** GitHub language, for type "github" (optional). */
  language?: string;
}

interface SourceDraft {
  type: SourceKind;
  connector: "api" | "feed";
  name: string;
  config: Record<string, unknown>;
  /** What makes two sources the same one, for duplicate detection. */
  identity: string;
}

/**
 * Validate the user's input for a new source and turn it into the row to store.
 * Every value that ends up in a URL or API query is checked against a strict
 * pattern first, so user input can't redirect a fetch somewhere unintended.
 *
 * @throws invalid_input, invalid_url.
 */
export function draftSource(args: Omit<AddSourceArgs, "ownerEmail" | "orgId">): SourceDraft {
  const limit = args.limit ? { limit: args.limit } : {};
  const custom = args.name?.trim();
  switch (args.type) {
    case "hn":
      return { type: "hn", connector: "api", name: custom || "Hacker News", config: limit, identity: "hn" };
    case "lobsters":
      return { type: "lobsters", connector: "api", name: custom || "Lobsters", config: limit, identity: "lobsters" };
    case "producthunt":
      return { type: "producthunt", connector: "feed", name: custom || "Product Hunt", config: { url: "https://www.producthunt.com/feed" }, identity: "producthunt" };
    case "devto": {
      const tag = args.tag?.trim().toLowerCase().replace(/^#/, "") || undefined;
      if (tag && !/^[a-z0-9]{1,30}$/.test(tag)) fail("A dev.to tag is letters and numbers only (for example webdev).", { errorCode: "invalid_input" });
      return { type: "devto", connector: "api", name: custom || (tag ? `dev.to #${tag}` : "dev.to"), config: { ...limit, ...(tag ? { tag } : {}) }, identity: `devto:${tag ?? ""}` };
    }
    case "github": {
      const language = args.language?.trim() || undefined;
      if (language && !/^[A-Za-z0-9+#.-]{1,30}$/.test(language)) fail("That doesn't look like a programming language name.", { errorCode: "invalid_input" });
      return { type: "github", connector: "api", name: custom || (language ? `GitHub new repos (${language})` : "GitHub new repos"), config: { ...limit, ...(language ? { language } : {}) }, identity: `github:${language?.toLowerCase() ?? ""}` };
    }
    case "reddit": {
      const sub = args.subreddit?.trim().replace(/^\/?r\//i, "");
      if (!sub) fail("A subreddit name is required.", { errorCode: "invalid_input" });
      if (!/^[A-Za-z0-9_]{2,21}$/.test(sub)) fail("A subreddit name is 2-21 letters, numbers, or underscores.", { errorCode: "invalid_input" });
      return { type: "reddit", connector: "feed", name: custom || `r/${sub}`, config: { url: `https://www.reddit.com/r/${sub}/.rss` }, identity: `reddit:${sub.toLowerCase()}` };
    }
    case "rss": {
      if (!args.url) fail("A feed URL is required for RSS/Atom sources", { errorCode: "invalid_input" });
      const url = normalizeFeedUrl(args.url);
      return { type: "rss", connector: "feed", name: custom || new URL(url).hostname, config: { url }, identity: `rss:${url}` };
    }
  }
}

/** The identity `draftSource` would give an already-stored source. */
function identityOf(row: typeof sources.$inferSelect): string {
  const cfg = readConfig(row.config) as { tag?: unknown; language?: unknown; url?: unknown };
  switch (row.type) {
    case "devto": return `devto:${typeof cfg.tag === "string" ? cfg.tag : ""}`;
    case "github": return `github:${typeof cfg.language === "string" ? cfg.language.toLowerCase() : ""}`;
    case "reddit": {
      const sub = typeof cfg.url === "string" ? /\/r\/([^/]+)\//i.exec(cfg.url)?.[1] : undefined;
      return `reddit:${(sub ?? "").toLowerCase()}`;
    }
    case "rss": return `rss:${typeof cfg.url === "string" ? cfg.url : ""}`;
    default: return row.type;
  }
}

async function insertSource(ownerEmail: string, orgId: string | null, draft: SourceDraft): Promise<string> {
  const id = randomUUID();
  await getDb().insert(sources).values({
    id,
    ownerEmail,
    orgId,
    type: draft.type,
    connector: draft.connector,
    name: draft.name.slice(0, 120),
    config: JSON.stringify(draft.config),
    origin: "user",
    status: "approved",
    trustWeight: 1,
  });
  return id;
}

/**
 * Add one source the user chose. Rejects a duplicate (same service and settings)
 * and refuses to go past `MAX_SOURCES`.
 *
 * @throws invalid_input, invalid_url, duplicate, source_limit.
 */
export async function addSource(args: AddSourceArgs): Promise<SourceView> {
  const { ownerEmail, orgId, ...input } = args;
  const draft = draftSource(input);
  const existing = await getDb().select().from(sources).where(eq(sources.ownerEmail, ownerEmail));
  if (existing.length >= MAX_SOURCES) fail(`You can have up to ${MAX_SOURCES} sources. Remove one first.`, { errorCode: "source_limit", statusCode: 409 });
  if (existing.some((row) => identityOf(row) === draft.identity)) fail("That source is already added", { errorCode: "duplicate", statusCode: 409 });

  await ensureSourceSettings(ownerEmail, orgId);
  const id = await insertSource(ownerEmail, orgId, draft);
  const [row] = await getDb().select().from(sources).where(eq(sources.id, id));
  return toView(row, 0);
}

export interface OpmlResult {
  added: number;
  skippedDuplicate: number;
  skippedInvalid: number;
  skippedOverLimit: number;
  /** Names of the first few feeds that were added. */
  addedNames: string[];
}

const OPML_MAX_FEEDS = 100;
const opmlParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });

/** Every outline with an `xmlUrl` in an OPML document (outlines nest, so walk them all). */
export function parseOpml(xml: string): { url: string; title?: string }[] {
  let doc: { opml?: { body?: unknown } };
  try {
    doc = opmlParser.parse(xml);
  } catch {
    fail("That file isn't valid OPML.", { errorCode: "invalid_opml" });
  }
  if (!doc?.opml?.body) fail("That file isn't valid OPML (no <opml><body> found).", { errorCode: "invalid_opml" });

  const found: { url: string; title?: string }[] = [];
  const walk = (node: unknown) => {
    if (found.length >= OPML_MAX_FEEDS * 2) return;
    for (const item of Array.isArray(node) ? node : [node]) {
      if (!item || typeof item !== "object") continue;
      const outline = item as Record<string, unknown>;
      const url = outline["@_xmlUrl"] ?? outline["@_xmlurl"];
      if (typeof url === "string") {
        const title = outline["@_title"] ?? outline["@_text"];
        found.push({ url, title: typeof title === "string" ? title : undefined });
      }
      if (outline.outline) walk(outline.outline);
    }
  };
  walk((doc.opml.body as Record<string, unknown>).outline);
  return found;
}

/**
 * Add every feed in an OPML export as an RSS source. Feeds already added,
 * invalid or non-http(s) URLs, and anything over the source cap are skipped, never
 * fatal, and counted in the result so nothing disappears silently.
 *
 * @throws invalid_opml when the file can't be read as OPML.
 */
export async function importOpml(args: { ownerEmail: string; orgId: string | null; opml: string }): Promise<OpmlResult> {
  const { ownerEmail, orgId } = args;
  const result: OpmlResult = { added: 0, skippedDuplicate: 0, skippedInvalid: 0, skippedOverLimit: 0, addedNames: [] };
  const feeds = parseOpml(args.opml);
  const existing = await getDb().select().from(sources).where(eq(sources.ownerEmail, ownerEmail));
  const known = new Set(existing.map(identityOf));
  let total = existing.length;
  if (feeds.length > 0) await ensureSourceSettings(ownerEmail, orgId);

  for (const feed of feeds.slice(0, OPML_MAX_FEEDS)) {
    let draft: SourceDraft;
    try {
      draft = draftSource({ type: "rss", url: feed.url, name: feed.title });
    } catch {
      result.skippedInvalid++;
      continue;
    }
    if (known.has(draft.identity)) {
      result.skippedDuplicate++;
      continue;
    }
    if (total >= MAX_SOURCES) {
      result.skippedOverLimit++;
      continue;
    }
    await insertSource(ownerEmail, orgId, draft);
    known.add(draft.identity);
    total++;
    result.added++;
    if (result.addedNames.length < 10) result.addedNames.push(draft.name);
  }
  result.skippedOverLimit += Math.max(0, feeds.length - OPML_MAX_FEEDS);
  return result;
}

export async function updateSource(args: {
  ownerEmail: string;
  id: string;
  enabled?: boolean;
  name?: string;
}): Promise<SourceView> {
  const { ownerEmail, id } = args;
  const db = getDb();
  const patch: Partial<typeof sources.$inferInsert> = {};
  if (args.enabled !== undefined) patch.enabled = args.enabled;
  if (args.name !== undefined) {
    const name = args.name.trim();
    if (!name) fail("Name cannot be empty", { errorCode: "invalid_input" });
    patch.name = name.slice(0, 120);
  }
  if (Object.keys(patch).length === 0) {
    fail("Nothing to update: pass enabled and/or name", { errorCode: "invalid_input" });
  }
  const updated = await db
    .update(sources)
    .set(patch)
    .where(and(eq(sources.id, id), eq(sources.ownerEmail, ownerEmail)))
    .returning({ id: sources.id });
  if (updated.length === 0) fail("Source not found", { errorCode: "not_found", statusCode: 404 });
  const [view] = (await listSources(ownerEmail)).filter((s) => s.id === id);
  return view;
}

/** Delete a source and everything derived from it (items, summaries, scores, feedback, runs). */
export async function removeSource(ownerEmail: string, id: string): Promise<{ removedItems: number }> {
  const db = getDb();
  return db.transaction(async (tx) => {
    const [source] = await tx
      .select({ id: sources.id })
      .from(sources)
      .where(and(eq(sources.id, id), eq(sources.ownerEmail, ownerEmail)));
    if (!source) fail("Source not found", { errorCode: "not_found", statusCode: 404 });
    const itemIds = (
      await tx.select({ id: items.id }).from(items).where(and(eq(items.sourceId, id), eq(items.ownerEmail, ownerEmail)))
    ).map((r) => r.id);
    // Clusters that lose a member are repaired or dissolved before the items go.
    await detachItems(tx, ownerEmail, itemIds);
    for (let i = 0; i < itemIds.length; i += 100) {
      const chunk = itemIds.slice(i, i + 100);
      await tx.delete(summaries).where(and(eq(summaries.ownerEmail, ownerEmail), inArray(summaries.itemId, chunk)));
      await tx.delete(scores).where(and(eq(scores.ownerEmail, ownerEmail), inArray(scores.itemId, chunk)));
      await tx.delete(feedback).where(and(eq(feedback.ownerEmail, ownerEmail), inArray(feedback.itemId, chunk)));
    }
    await tx.delete(items).where(and(eq(items.sourceId, id), eq(items.ownerEmail, ownerEmail)));
    await tx.delete(runs).where(and(eq(runs.sourceId, id), eq(runs.ownerEmail, ownerEmail)));
    await tx.delete(sources).where(and(eq(sources.id, id), eq(sources.ownerEmail, ownerEmail)));
    return { removedItems: itemIds.length };
  });
}
