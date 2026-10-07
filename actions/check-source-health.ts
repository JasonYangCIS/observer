import { z } from "zod";
import { defineAction, fail } from "@agent-native/core/action";
import { getRequestUserEmail } from "@agent-native/core/server";
import { checkSourceHealth } from "../server/lib/health.js";

export default defineAction({
  description:
    "Check the health of the user's sources and record it on each one: failing (3+ fetches in a row failed), never fetched (no success two days after adding), stale (newest item over 30 days old), or mostly skipped (the user skips 80%+ of its items, at least 5). Sources the user added are only flagged, never switched off; sources the agent discovered that are unhealthy are switched off. fetch-source already refreshes the fetched source's health, so this is for a full sweep. Returns every source's status and the sources that need attention with plain-language reasons; tell the user about those.",
  schema: z.object({
    sourceId: z.string().min(1).optional().describe("Check just this source. Omit to check all of them."),
  }),
  run: async ({ sourceId }) => {
    const ownerEmail = getRequestUserEmail();
    if (!ownerEmail) fail("Sign in required", { errorCode: "unauthorized", statusCode: 401 });
    const report = await checkSourceHealth(ownerEmail, sourceId ? [sourceId] : undefined);
    if (sourceId && report.length === 0) fail("Source not found", { errorCode: "not_found", statusCode: 404 });
    return { checked: report.length, needsAttention: report.filter((r) => r.status !== "ok"), report };
  },
});
