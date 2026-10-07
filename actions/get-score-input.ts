import { z } from "zod";
import { defineAction, fail } from "@agent-native/core/action";
import { getRequestOrgId, getRequestUserEmail } from "@agent-native/core/server";
import { getScoreInput, listPendingScores } from "../server/lib/scores.js";

export default defineAction({
  description:
    "Read what you need to judge one item's relevance to the user. With itemId: returns the item, its source, its summary, the deterministic importance it will be stored with, the user's interest profile (their own words), and any existing score. Without itemId: lists up to `limit` summarized items that have no score yet. Save the result with score-item; follow the score-reason skill.",
  schema: z.object({
    itemId: z.string().min(1).optional().describe("Item to read. Omit to list summarized items that still need a score."),
    limit: z.number().int().min(1).max(25).default(10).describe("How many pending items to list when itemId is omitted (1-25, default 10)"),
  }),
  http: { method: "GET" },
  readOnly: true,
  run: async ({ itemId, limit }) => {
    const ownerEmail = getRequestUserEmail();
    if (!ownerEmail) fail("Sign in required", { errorCode: "unauthorized", statusCode: 401 });
    if (itemId) return getScoreInput(ownerEmail, getRequestOrgId() ?? null, itemId);
    return { pending: await listPendingScores(ownerEmail, limit) };
  },
});
