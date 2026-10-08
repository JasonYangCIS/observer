import { z } from "zod";
import { defineAction, fail } from "@agent-native/core/action";
import { getRequestUserEmail } from "@agent-native/core/server";
import { listFeed } from "../server/lib/feed.js";

export default defineAction({
  description:
    "Return the user's ranked feed: summarized and scored items from enabled sources, best first (60% relevance, 20% importance, 20% recency, plus up to ±10 points for how much the user trusts the source, which moves with their likes, saves, opens, and skips). Each item has its summary, relevance, importance, the plain-language reason, source (name, type, trusted or discovered), and links to the article and discussion. Up to two items per ten (`exploration: true`) are high-buzz, low-relevance picks placed at the 4th and 9th positions to keep the feed from becoming a bubble; only items with measured importance qualify. `sort: newest` orders purely by date (no exploration picks) and `hideRead: true` leaves out items the user has opened; `readCount` is how many in the feed are read. `progress` counts items still waiting to be fetched, summarized, or scored.",
  schema: z.object({
    limit: z.number().int().min(1).max(100).default(30).describe("Maximum items to return (1-100, default 30)"),
    sourceId: z.string().min(1).optional().describe("Only items from this source (id from list-sources)"),
    sort: z.enum(["ranked", "newest"]).default("ranked").describe('"ranked" (default): the blended score. "newest": purely by date, newest first'),
    hideRead: z
      .union([z.boolean(), z.enum(["true", "false"]).transform((v) => v === "true")])
      .default(false)
      .describe("true to leave out items the user has already opened (applied before the limit)"),
    view: z.enum(["feed", "saved"]).default("feed").describe('"feed" (default) hides skipped items; "saved" lists only items the user saved'),
  }),
  http: { method: "GET" },
  readOnly: true,
  run: async ({ limit, sourceId, view, sort, hideRead }) => {
    const ownerEmail = getRequestUserEmail();
    if (!ownerEmail) fail("Sign in required", { errorCode: "unauthorized", statusCode: 401 });
    return listFeed({ ownerEmail, limit, sourceId, view, sort, hideRead });
  },
});
