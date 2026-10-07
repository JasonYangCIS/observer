import { z } from "zod";
import { defineAction, fail } from "@agent-native/core/action";
import { getRequestOrgId, getRequestUserEmail } from "@agent-native/core/server";
import { saveScore } from "../server/lib/scores.js";

export default defineAction({
  description:
    "Save your relevance judgment for one summarized item (read it first with get-score-input). relevance is 0-100 for THIS user; importance (general buzz) is computed by the server from real engagement numbers, not by you. Give a 20-300 character reason in plain language and the interests you matched, quoted from the user's interest profile; a relevance of 50+ must cite at least one. The saved reason always shows the matched interests and the buzz basis. Never leave a score without a reason.",
  schema: z.object({
    itemId: z.string().min(1).describe("Item being scored (it must already have a summary)"),
    relevance: z.number().int().min(0).max(100).describe("0-100: how well this fits the user's interests. 0 = unrelated, 50 = loosely related, 80+ = squarely what they asked for."),
    matchedInterests: z.array(z.string().max(120)).max(6).default([]).describe("Phrases quoted from the user's interest profile that this item matches. Empty only if relevance is under 50."),
    reason: z.string().max(600).describe("20-300 characters, plain language: why this is or isn't relevant to this user. No bare numbers."),
  }),
  run: async (args) => {
    const ownerEmail = getRequestUserEmail();
    if (!ownerEmail) fail("Sign in required", { errorCode: "unauthorized", statusCode: 401 });
    return saveScore({ ownerEmail, orgId: getRequestOrgId() ?? null, ...args });
  },
});
