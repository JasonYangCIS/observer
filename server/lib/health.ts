import { and, count, eq, inArray, sql } from "drizzle-orm";
import { getDb, schema } from "../db/index.js";
import { parseTimestamp } from "./time.js";

const { sources, items, feedback } = schema;

/** This many failed fetches in a row marks a source as failing. */
export const FAILING_ERRORS = 3;
/** A source that has never fetched successfully after this long is flagged. */
export const NEVER_FETCHED_DAYS = 2;
/** A source whose newest item is older than this has probably stopped publishing. */
export const STALE_DAYS = 30;
/** Mostly skipped: at least this many skips, and skips are at least this share of likes + saves + skips. */
export const SKIP_MIN = 5;
export const SKIP_RATIO = 0.8;

const DAY_MS = 86_400_000;

export type HealthStatus = "ok" | "failing" | "never_fetched" | "stale" | "mostly_skipped";

/** Everything the assessment needs about one source. */
export interface HealthStats {
  origin: string;
  enabled: boolean;
  errorCount: number;
  lastError: string | null;
  lastSuccessAt: string | null;
  createdAt: string;
  itemCount: number;
  /** Date of the newest item (posted or first seen), or null when there are none. */
  newestItemAt: string | null;
  likes: number;
  saves: number;
  skips: number;
}

export interface HealthAssessment {
  status: HealthStatus;
  /** Plain-language reasons, most serious first; empty when ok. */
  reasons: string[];
  /** True when a discovered (not user-added) source should be switched off. */
  shouldDisable: boolean;
}

const PRIORITY: HealthStatus[] = ["failing", "never_fetched", "stale", "mostly_skipped"];

/**
 * Decide a source's health from its stats. Pure and deterministic.
 *
 * Statuses, most serious first: failing (3+ failed fetches in a row), never
 * fetched (no successful fetch two days after it was added), stale (its newest
 * item is over 30 days old), mostly skipped (5+ skips and skips are 80% or more of
 * the feedback on it). Disabled sources are not assessed. The reasons list every
 * problem found, and the status is the most serious one.
 *
 * `shouldDisable` is only ever true for sources the agent discovered (origin other
 * than "user"): a source the user added is flagged and left alone, because
 * silently switching off something they chose would be worse than the problem.
 */
export function assessHealth(stats: HealthStats, now = Date.now()): HealthAssessment {
  if (!stats.enabled) return { status: "ok", reasons: [], shouldDisable: false };

  const found = new Map<HealthStatus, string>();
  if (stats.errorCount >= FAILING_ERRORS) {
    const last = stats.lastError ? ` Last error: ${stats.lastError}` : "";
    found.set("failing", `The last ${stats.errorCount} fetches failed.${last}`);
  }
  const createdMs = parseTimestamp(stats.createdAt);
  if (!stats.lastSuccessAt && stats.errorCount < FAILING_ERRORS && createdMs !== null && now - createdMs >= NEVER_FETCHED_DAYS * DAY_MS) {
    found.set("never_fetched", `It was added over ${NEVER_FETCHED_DAYS} days ago and has never been fetched successfully.`);
  }
  const newestMs = parseTimestamp(stats.newestItemAt);
  if (stats.itemCount > 0 && newestMs !== null && now - newestMs > STALE_DAYS * DAY_MS) {
    found.set("stale", `Its newest item is ${Math.floor((now - newestMs) / DAY_MS)} days old, so it may have stopped publishing.`);
  }
  const reacted = stats.likes + stats.saves + stats.skips;
  if (stats.skips >= SKIP_MIN && stats.skips / reacted >= SKIP_RATIO) {
    found.set("mostly_skipped", `You skipped ${stats.skips} of the ${reacted} items you reacted to from this source.`);
  }

  const status = PRIORITY.find((p) => found.has(p)) ?? "ok";
  const reasons = PRIORITY.filter((p) => found.has(p)).map((p) => found.get(p)!);
  return { status, reasons, shouldDisable: status !== "ok" && stats.origin !== "user" };
}

export interface HealthReportRow {
  sourceId: string;
  name: string;
  status: HealthStatus;
  reasons: string[];
  /** True if this check switched the source off (discovered sources only). */
  autoDisabled: boolean;
}

async function loadStats(ownerEmail: string, sourceIds?: string[]) {
  const db = getDb();
  const rows = await db
    .select()
    .from(sources)
    .where(and(eq(sources.ownerEmail, ownerEmail), ...(sourceIds ? [inArray(sources.id, sourceIds)] : [])));
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);

  const itemStats = await db
    .select({
      sourceId: items.sourceId,
      n: count(),
      newest: sql<string | null>`max(coalesce(${items.postedAt}, ${items.createdAt})::timestamptz)::text`,
    })
    .from(items)
    .where(and(eq(items.ownerEmail, ownerEmail), inArray(items.sourceId, ids)))
    .groupBy(items.sourceId);
  const feedbackStats = await db
    .select({ sourceId: items.sourceId, signal: feedback.signal, n: count() })
    .from(feedback)
    .innerJoin(items, and(eq(items.id, feedback.itemId), eq(items.ownerEmail, ownerEmail)))
    .where(and(eq(feedback.ownerEmail, ownerEmail), inArray(items.sourceId, ids)))
    .groupBy(items.sourceId, feedback.signal);

  return rows.map((row) => {
    const item = itemStats.find((s) => s.sourceId === row.id);
    const signal = (name: string) => Number(feedbackStats.find((f) => f.sourceId === row.id && f.signal === name)?.n ?? 0);
    const stats: HealthStats = {
      origin: row.origin,
      enabled: row.enabled,
      errorCount: row.errorCount,
      lastError: row.lastError,
      lastSuccessAt: row.lastSuccessAt,
      createdAt: row.createdAt,
      itemCount: Number(item?.n ?? 0),
      newestItemAt: item?.newest ?? null,
      likes: signal("like"),
      saves: signal("save"),
      skips: signal("skip"),
    };
    return { row, stats };
  });
}

/**
 * Assess the owner's sources (or just `sourceIds`), store the result on each
 * source for the UI, and switch off discovered sources that are unhealthy.
 * User-added sources are only ever flagged. Returns one row per source.
 */
export async function checkSourceHealth(ownerEmail: string, sourceIds?: string[], now = Date.now()): Promise<HealthReportRow[]> {
  const db = getDb();
  const report: HealthReportRow[] = [];
  for (const { row, stats } of await loadStats(ownerEmail, sourceIds)) {
    const assessment = assessHealth(stats, now);
    const disable = assessment.shouldDisable && row.enabled;
    await db
      .update(sources)
      .set({
        healthStatus: assessment.status,
        healthReason: assessment.reasons[0] ?? null,
        healthCheckedAt: new Date(now).toISOString(),
        ...(disable ? { enabled: false, status: "disabled" } : {}),
      })
      .where(and(eq(sources.id, row.id), eq(sources.ownerEmail, ownerEmail)));
    report.push({ sourceId: row.id, name: row.name, status: assessment.status, reasons: assessment.reasons, autoDisabled: disable });
  }
  return report;
}
