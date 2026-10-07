import { z } from "zod";
import { defineAction, fail } from "@agent-native/core/action";
import { getRequestOrgId, getRequestUserEmail } from "@agent-native/core/server";
import { ingestSource } from "../server/lib/ingest.js";

export default defineAction({
  description:
    "Fetch new items from one approved, enabled source (Hacker News API or RSS/Atom feed) and upsert them into the feed. Returns counts of fetched, new, and updated items. Does not summarize or score.",
  schema: z.object({
    sourceId: z.string().min(1).describe("Id of the source to fetch (from the sources list)"),
  }),
  run: async ({ sourceId }) => {
    const ownerEmail = getRequestUserEmail();
    if (!ownerEmail) fail("Sign in required", { errorCode: "unauthorized", statusCode: 401 });
    return ingestSource({ ownerEmail, orgId: getRequestOrgId() ?? null, sourceId });
  },
});
