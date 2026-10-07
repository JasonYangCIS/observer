import { z } from "zod";
import { defineAction, fail } from "@agent-native/core/action";
import { getRequestUserEmail } from "@agent-native/core/server";
import { listFeed } from "../server/lib/feed.js";

export default defineAction({
  description:
    "Return the user's ranked feed: summarized and scored items from enabled sources, best first (60% relevance, 20% importance, 20% recency). Each item has its summary, relevance, importance, the plain-language reason, source (name, type, trusted or discovered), and links to the article and discussion. `progress` counts items still waiting to be fetched, summarized, or scored.",
  schema: z.object({
    limit: z.number().int().min(1).max(100).default(30).describe("Maximum items to return (1-100, default 30)"),
    sourceId: z.string().min(1).optional().describe("Only items from this source (id from list-sources)"),
  }),
  http: { method: "GET" },
  readOnly: true,
  run: async ({ limit, sourceId }) => {
    const ownerEmail = getRequestUserEmail();
    if (!ownerEmail) fail("Sign in required", { errorCode: "unauthorized", statusCode: 401 });
    return listFeed({ ownerEmail, limit, sourceId });
  },
});
