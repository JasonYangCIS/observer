import { z } from "zod";
import { defineAction, fail } from "@agent-native/core/action";
import { getRequestUserEmail } from "@agent-native/core/server";
import { fetchArticleText, fetchPendingArticles } from "../server/lib/article-text.js";

export default defineAction({
  description:
    'Fetch and store the readable text of article pages. Pass itemId for one item, or omit it to process up to `limit` items that have not been tried yet (newest first). Each result has status "ok", "paywalled", or "failed" plus an error explaining why; a paywalled or unreadable page is recorded, not guessed, so summaries must say the article could not be read. Stored text is reused unless force is true; failed pages are not retried for 6 hours unless forced.',
  schema: z.object({
    itemId: z.string().min(1).optional().describe("Item to fetch. Omit to process pending items in a batch."),
    limit: z.number().int().min(1).max(25).default(10).describe("Batch size when itemId is omitted (1-25, default 10)"),
    force: z.boolean().default(false).describe("Re-fetch even if text is stored or a recent attempt failed. Only applies with itemId."),
  }),
  run: async ({ itemId, limit, force }) => {
    const ownerEmail = getRequestUserEmail();
    if (!ownerEmail) fail("Sign in required", { errorCode: "unauthorized", statusCode: 401 });
    if (itemId) return { results: [await fetchArticleText({ ownerEmail, itemId, force })] };
    return { results: await fetchPendingArticles({ ownerEmail, limit }) };
  },
});
