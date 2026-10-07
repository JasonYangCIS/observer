import { randomUUID } from "node:crypto";
import { fail } from "@agent-native/core/action";
import { and, eq, inArray, sql } from "drizzle-orm";
import { getDb, schema } from "../db/index.js";
import { getConnector } from "./connectors/index.js";
import type { NormalizedItem } from "./connectors/types.js";
import { FetchError, safeFetchText, type DomainPolicy, type FetchText } from "./safe-fetch.js";

const { sources, items, runs, sourceSettings } = schema;
const CHUNK = 100;

export interface IngestResult {
  sourceId: string;
  runId: string;
  fetched: number;
  newItems: number;
  updatedItems: number;
}

function parseList(json: string): string[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function describeError(err: unknown): string {
  if (err instanceof FetchError) return `${err.code}: ${err.message}`;
  return (err instanceof Error ? err.message : String(err)).slice(0, 500);
}

/**
 * Fetch one source and upsert its items for the owner. Records a `runs` row and
 * updates the source's health either way, so failures are visible in the UI.
 */
export async function ingestSource(args: {
  ownerEmail: string;
  orgId?: string | null;
  sourceId: string;
  fetchText?: FetchText;
}): Promise<IngestResult> {
  const { ownerEmail, orgId = null, sourceId, fetchText = safeFetchText } = args;
  const db = getDb();

  const [source] = await db
    .select()
    .from(sources)
    .where(and(eq(sources.id, sourceId), eq(sources.ownerEmail, ownerEmail)))
    .limit(1);
  if (!source) fail("Source not found", { errorCode: "not_found", statusCode: 404 });
  if (!source.enabled || source.status !== "approved") {
    fail("Source is disabled or not approved", { errorCode: "source_inactive", statusCode: 409 });
  }

  const [settings] = await db
    .select()
    .from(sourceSettings)
    .where(eq(sourceSettings.ownerEmail, ownerEmail))
    .limit(1);
  const policy: DomainPolicy = {
    allowlist: settings ? parseList(settings.allowlistDomains) : [],
    denylist: settings ? parseList(settings.denylistDomains) : [],
  };

  const runId = randomUUID();
  await db.insert(runs).values({ id: runId, ownerEmail, orgId, kind: "ingest", sourceId });

  try {
    const fetched = await getConnector(source).fetchItems(source, { fetchText, policy });
    // De-duplicate within the batch so one upsert never touches a row twice.
    const unique = [...new Map(fetched.map((i) => [i.externalId, i])).values()];

    const { newItems, updatedItems } = await upsertItems(ownerEmail, orgId, sourceId, unique);

    const now = new Date().toISOString();
    await db
      .update(sources)
      .set({ lastSuccessAt: now, errorCount: 0, lastError: null })
      .where(and(eq(sources.id, sourceId), eq(sources.ownerEmail, ownerEmail)));
    await db
      .update(runs)
      .set({ status: "ok", finishedAt: now, itemsProcessed: unique.length })
      .where(eq(runs.id, runId));
    return { sourceId, runId, fetched: unique.length, newItems, updatedItems };
  } catch (err) {
    const message = describeError(err);
    const now = new Date().toISOString();
    await db
      .update(sources)
      .set({ errorCount: sql`${sources.errorCount} + 1`, lastError: message })
      .where(and(eq(sources.id, sourceId), eq(sources.ownerEmail, ownerEmail)));
    await db
      .update(runs)
      .set({ status: "error", finishedAt: now, error: message })
      .where(eq(runs.id, runId));
    fail(`Fetching "${source.name}" failed: ${message}`, {
      errorCode: "fetch_failed",
      statusCode: 502,
    });
  }
}

async function upsertItems(
  ownerEmail: string,
  orgId: string | null,
  sourceId: string,
  batch: NormalizedItem[],
): Promise<{ newItems: number; updatedItems: number }> {
  if (batch.length === 0) return { newItems: 0, updatedItems: 0 };
  const db = getDb();

  const existing = new Set<string>();
  for (let i = 0; i < batch.length; i += CHUNK) {
    const ids = batch.slice(i, i + CHUNK).map((b) => b.externalId);
    const rows = await db
      .select({ externalId: items.externalId })
      .from(items)
      .where(and(eq(items.sourceId, sourceId), eq(items.ownerEmail, ownerEmail), inArray(items.externalId, ids)));
    for (const r of rows) existing.add(r.externalId);
  }

  for (let i = 0; i < batch.length; i += CHUNK) {
    const values = batch.slice(i, i + CHUNK).map((b) => ({
      id: randomUUID(),
      ownerEmail,
      orgId,
      sourceId,
      externalId: b.externalId,
      url: b.url,
      discussionUrl: b.discussionUrl ?? null,
      title: b.title,
      author: b.author ?? null,
      postedAt: b.postedAt ?? null,
      rawMetrics: JSON.stringify(b.metrics),
    }));
    // Re-fetching refreshes title and engagement numbers; text and summaries are untouched.
    await db
      .insert(items)
      .values(values)
      .onConflictDoUpdate({
        target: [items.sourceId, items.externalId],
        set: {
          title: sql`excluded.title`,
          rawMetrics: sql`excluded.raw_metrics`,
          discussionUrl: sql`excluded.discussion_url`,
        },
      });
  }
  const updatedItems = batch.filter((b) => existing.has(b.externalId)).length;
  return { newItems: batch.length - updatedItems, updatedItems };
}
