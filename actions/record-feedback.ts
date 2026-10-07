import { z } from "zod";
import { defineAction, fail } from "@agent-native/core/action";
import { getRequestOrgId, getRequestUserEmail } from "@agent-native/core/server";
import { SIGNALS, recordFeedback } from "../server/lib/feedback.js";

export default defineAction({
  description:
    'Record or clear the user\'s feedback on a feed item: "like", "skip" (hides it from the feed), "save" (adds it to the Saved view), or "opened" (the user opened the article). like and skip are mutually exclusive; save is independent. Pass active: false to undo like, skip, or save; opened can\'t be undone. Returns the item\'s feedback state afterwards.',
  schema: z.object({
    itemId: z.string().min(1).describe("Item the feedback is about"),
    signal: z.enum(SIGNALS).describe('"like", "skip", "save", or "opened"'),
    active: z.boolean().default(true).describe("true to set the signal (default), false to clear it"),
  }),
  run: async ({ itemId, signal, active }) => {
    const ownerEmail = getRequestUserEmail();
    if (!ownerEmail) fail("Sign in required", { errorCode: "unauthorized", statusCode: 401 });
    return recordFeedback({ ownerEmail, orgId: getRequestOrgId() ?? null, itemId, signal, active });
  },
});
