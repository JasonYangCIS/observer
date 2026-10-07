import { randomUUID } from "node:crypto";
import { fail } from "@agent-native/core/action";
import { and, count, eq, sql } from "drizzle-orm";
import { getDb, schema } from "../db/index.js";

const { interestProfiles, scores, items } = schema;

/** Starting profile for a new user. Plain language, meant to be read and edited. */
export const DEFAULT_INTEREST_PROFILE =
  "I follow software engineering, web development, developer tools, AI and machine learning, open source, and startups. I'm less interested in celebrity news, sports, and general politics.";

export const MIN_PROFILE_CHARS = 20;
export const MAX_PROFILE_CHARS = 2000;
/** Only items this recent are re-scored after the profile changes, to bound cost. */
export const RESCORE_WINDOW_DAYS = 14;

/**
 * SQL predicate: this score was written before the owner's profile last
 * changed, on an item recent enough to be worth re-scoring. Both columns hold
 * either ISO-8601 or Postgres `now()` text, and both cast cleanly to timestamptz.
 */
export function staleScoreCondition() {
  return and(
    sql`${scores.createdAt}::timestamptz < ${interestProfiles.updatedAt}::timestamptz`,
    sql`${items.createdAt}::timestamptz > now() - make_interval(days => ${RESCORE_WINDOW_DAYS})`,
  );
}

/**
 * Return the owner's interest profile text, creating the default one the first
 * time. Safe to call concurrently: the unique owner index makes the insert a no-op
 * if another request created it first.
 */
export async function ensureInterestProfile(ownerEmail: string, orgId: string | null): Promise<string> {
  const db = getDb();
  await db
    .insert(interestProfiles)
    .values({ id: randomUUID(), ownerEmail, orgId, profileText: DEFAULT_INTEREST_PROFILE })
    .onConflictDoNothing({ target: interestProfiles.ownerEmail });
  const [row] = await db.select().from(interestProfiles).where(eq(interestProfiles.ownerEmail, ownerEmail)).limit(1);
  return row.profileText;
}

/** Strip control characters, normalize line endings and runs of blank space, and trim. */
export function cleanProfileText(raw: string): string {
  return raw
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export interface InterestsView {
  profileText: string;
  /** ISO-ish timestamp of the last change to the profile. */
  updatedAt: string;
  isDefault: boolean;
  defaultText: string;
  /** Recent scores written before the last change; they are re-scored on the next update. */
  staleScores: number;
}

async function countStaleScores(ownerEmail: string): Promise<number> {
  const [row] = await getDb()
    .select({ n: count() })
    .from(scores)
    .innerJoin(items, and(eq(items.id, scores.itemId), eq(items.ownerEmail, ownerEmail)))
    .innerJoin(interestProfiles, eq(interestProfiles.ownerEmail, scores.ownerEmail))
    .where(and(eq(scores.ownerEmail, ownerEmail), staleScoreCondition()));
  return Number(row.n);
}

/** The owner's interest profile (created from the default on first read) and how many scores it has made stale. */
export async function getInterests(ownerEmail: string, orgId: string | null): Promise<InterestsView> {
  await ensureInterestProfile(ownerEmail, orgId);
  const [row] = await getDb().select().from(interestProfiles).where(eq(interestProfiles.ownerEmail, ownerEmail)).limit(1);
  return {
    profileText: row.profileText,
    updatedAt: row.updatedAt,
    isDefault: row.profileText === DEFAULT_INTEREST_PROFILE,
    defaultText: DEFAULT_INTEREST_PROFILE,
    staleScores: await countStaleScores(ownerEmail),
  };
}

/**
 * Replace the owner's interest profile with `profileText`.
 *
 * The text is the user's own plain-language description; it is stored as given
 * (after cleaning), never summarized or rewritten by the server. Saving text
 * that matches the current profile changes nothing, so it can't make every
 * score look stale. Otherwise recent scores become stale and are re-scored by
 * the next update.
 *
 * @throws invalid_profile when the cleaned text is under 20 or over 2000 characters.
 */
export async function updateInterests(args: { ownerEmail: string; orgId: string | null; profileText: string }): Promise<InterestsView & { changed: boolean }> {
  const { ownerEmail, orgId } = args;
  const text = cleanProfileText(args.profileText);
  if (text.length < MIN_PROFILE_CHARS || text.length > MAX_PROFILE_CHARS) {
    fail(`The interest profile must be ${MIN_PROFILE_CHARS}-${MAX_PROFILE_CHARS} characters (got ${text.length}).`, { errorCode: "invalid_profile" });
  }
  const current = await ensureInterestProfile(ownerEmail, orgId);
  const changed = current !== text;
  if (changed) {
    await getDb()
      .update(interestProfiles)
      .set({ profileText: text, updatedAt: new Date().toISOString() })
      .where(eq(interestProfiles.ownerEmail, ownerEmail));
  }
  return { ...(await getInterests(ownerEmail, orgId)), changed };
}
