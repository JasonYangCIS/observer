import { z } from "zod";
import { defineAction, fail } from "@agent-native/core/action";
import { getRequestOrgId, getRequestUserEmail } from "@agent-native/core/server";
import { MAX_CITATIONS, MAX_SUMMARY_CHARS, MIN_SUMMARY_CHARS, saveSummary } from "../server/lib/summaries.js";

export default defineAction({
  description:
    "Save a short cited summary you wrote for one item (read it first with get-summary-input). The summary must be your own wording and claim only what the article text says; every citation must be a verbatim quote from that text or the whole save is rejected. If the article couldn't be read (failed or paywalled), call with unavailable: true and no summary text: the server records that the article couldn't be read. Never summarize from the title alone.",
  schema: z.object({
    itemId: z.string().min(1).describe("Item the summary is for"),
    summaryText: z
      .string()
      .max(2000)
      .optional()
      .describe(`${MIN_SUMMARY_CHARS}-${MAX_SUMMARY_CHARS} characters, your own words. Omit when unavailable is true.`),
    citations: z
      .array(z.object({ quote: z.string().max(1000).describe("Verbatim 20-300 character quote from the article text supporting a claim") }))
      .max(MAX_CITATIONS + 4)
      .optional()
      .describe(`1-${MAX_CITATIONS} verbatim quotes that support the summary's claims. Omit when unavailable is true.`),
    unavailable: z.boolean().default(false).describe("true only when get-summary-input says the article wasn't readable"),
    model: z.string().max(120).optional().describe("Name of the model that wrote the summary, if you know it"),
  }),
  run: async (args) => {
    const ownerEmail = getRequestUserEmail();
    if (!ownerEmail) fail("Sign in required", { errorCode: "unauthorized", statusCode: 401 });
    return saveSummary({ ownerEmail, orgId: getRequestOrgId() ?? null, ...args });
  },
});
