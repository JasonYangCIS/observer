import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb, schema } from "../db/index.js";

const { interestProfiles } = schema;

/** Starting profile for a new user. Plain language, meant to be read and edited. */
export const DEFAULT_INTEREST_PROFILE =
  "I follow software engineering, web development, developer tools, AI and machine learning, open source, and startups. I'm less interested in celebrity news, sports, and general politics.";

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
