import { and, count, eq } from "drizzle-orm";
import { getDb, schema } from "../db/index.js";

const { feedback, items, sources } = schema;

/** Baseline trust by origin: sources the user added themselves start at 1; agent-discovered ones start lower (Phase 3). */
export const BASE_TRUST: Record<string, number> = { user: 1, agent_discovered: 0.5 };
export const MIN_TRUST = 0.1;
export const MAX_TRUST = 2;
/** Points of ranking score a source's trust can add or remove: trust 1.5 adds 10, trust 0.5 removes 10. */
export const TRUST_RANK_POINTS = 20;

export interface SourceFeedbackCounts {
  likes: number;
  saves: number;
  opens: number;
  skips: number;
}

/**
 * A source's trust weight from what the user did with its items.
 *
 * Likes count 1, saves 2, opens a weak 0.25; skips count against it at 1.5. The
 * balance is shrunk toward zero by a constant of 5, so one like barely moves it
 * and a long consistent history moves it a lot: delta = (positive - negative) /
 * (positive + negative + 5), always within (-1, 1). The result is the origin's
 * base weight scaled by 1 + 0.5 * delta, within [0.1, 2]. Computed from the full
 * history each time, so it is deterministic and undoing feedback undoes its effect.
 */
export function computeTrustWeight(origin: string, counts: SourceFeedbackCounts): number {
  const base = BASE_TRUST[origin] ?? 1;
  const positive = counts.likes + 2 * counts.saves + 0.25 * counts.opens;
  const negative = 1.5 * counts.skips;
  const delta = (positive - negative) / (positive + negative + 5);
  const weight = base * (1 + 0.5 * delta);
  return Math.round(Math.min(MAX_TRUST, Math.max(MIN_TRUST, weight)) * 1000) / 1000;
}

/** Ranking adjustment for a trust weight (0 at trust 1). */
export function trustRankAdjustment(trustWeight: number): number {
  return TRUST_RANK_POINTS * (trustWeight - 1);
}

/**
 * Recompute and store the trust weight of the source an item belongs to, from the
 * owner's feedback on all of that source's items.
 *
 * @returns the new weight, or null if the item or its source doesn't exist.
 */
export async function recomputeSourceTrust(ownerEmail: string, itemId: string): Promise<number | null> {
  const db = getDb();
  const [item] = await db.select({ sourceId: items.sourceId }).from(items).where(and(eq(items.id, itemId), eq(items.ownerEmail, ownerEmail))).limit(1);
  if (!item) return null;
  const [source] = await db.select({ id: sources.id, origin: sources.origin }).from(sources).where(and(eq(sources.id, item.sourceId), eq(sources.ownerEmail, ownerEmail))).limit(1);
  if (!source) return null;

  const rows = await db
    .select({ signal: feedback.signal, n: count() })
    .from(feedback)
    .innerJoin(items, and(eq(items.id, feedback.itemId), eq(items.ownerEmail, ownerEmail)))
    .where(and(eq(feedback.ownerEmail, ownerEmail), eq(items.sourceId, source.id)))
    .groupBy(feedback.signal);
  const n = (signal: string) => Number(rows.find((r) => r.signal === signal)?.n ?? 0);
  const weight = computeTrustWeight(source.origin, { likes: n("like"), saves: n("save"), opens: n("opened"), skips: n("skip") });

  await db.update(sources).set({ trustWeight: weight }).where(and(eq(sources.id, source.id), eq(sources.ownerEmail, ownerEmail)));
  return weight;
}
