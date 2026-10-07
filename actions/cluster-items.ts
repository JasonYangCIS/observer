import { z } from "zod";
import { defineAction, fail } from "@agent-native/core/action";
import { getRequestOrgId, getRequestUserEmail } from "@agent-native/core/server";
import { runClustering } from "../server/lib/cluster.js";

export default defineAction({
  description:
    "Group items from different sources that link to the same article (same URL after ignoring www, tracking parameters, and fragments). Only one item per group is fetched, summarized, and scored; the rest show as \"also on\" badges. fetch-source already does this after every fetch, so call this only to backfill or after changing sources. Safe to repeat. Returns how many clusters were created and items grouped.",
  schema: z.object({}),
  run: async () => {
    const ownerEmail = getRequestUserEmail();
    if (!ownerEmail) fail("Sign in required", { errorCode: "unauthorized", statusCode: 401 });
    return runClustering(ownerEmail, getRequestOrgId() ?? null);
  },
});
