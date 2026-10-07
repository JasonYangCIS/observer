import { randomUUID } from "node:crypto";
import { fail } from "@agent-native/core/action";
import { and, count, eq, inArray } from "drizzle-orm";
import { getDb, schema } from "../db/index.js";

const { sources, sourceSettings, items, summaries, scores, runs, feedback } = schema;

export type SourceKind = "hn" | "rss";

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

export async function addSource(args: {
  ownerEmail: string;
  orgId: string | null;
  type: SourceKind;
  name?: string;
  url?: string;
  limit?: number;
}): Promise<SourceView> {
  const { ownerEmail, orgId, type } = args;
  const db = getDb();
  const existing = await db.select().from(sources).where(eq(sources.ownerEmail, ownerEmail));

  let config: Record<string, unknown>;
  let name: string;
  let connector: string;
  if (type === "hn") {
    if (existing.some((s) => s.type === "hn")) {
      fail("Hacker News is already added", { errorCode: "duplicate", statusCode: 409 });
    }
    connector = "api";
    name = args.name?.trim() || "Hacker News";
    config = args.limit ? { limit: args.limit } : {};
  } else {
    if (!args.url) fail("A feed URL is required for RSS/Atom sources", { errorCode: "invalid_input" });
    const url = normalizeFeedUrl(args.url);
    if (existing.some((s) => s.type === "rss" && readConfig(s.config).url === url)) {
      fail("That feed is already added", { errorCode: "duplicate", statusCode: 409 });
    }
    connector = "feed";
    name = args.name?.trim() || new URL(url).hostname;
    config = { url };
  }

  await ensureSourceSettings(ownerEmail, orgId);
  const id = randomUUID();
  await db.insert(sources).values({
    id,
    ownerEmail,
    orgId,
    type,
    connector,
    name: name.slice(0, 120),
    config: JSON.stringify(config),
    origin: "user",
    status: "approved",
    trustWeight: 1,
  });
  const [row] = await db.select().from(sources).where(eq(sources.id, id));
  return toView(row, 0);
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
