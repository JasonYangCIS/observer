import { z } from "zod";
import { defineAction, fail } from "@agent-native/core/action";
import { getRequestOrgId, getRequestUserEmail } from "@agent-native/core/server";
import { MAX_PROFILE_CHARS, MIN_PROFILE_CHARS, updateInterests } from "../server/lib/interests.js";

export default defineAction({
  description:
    "Replace the user's interest profile with new plain-language text. To act on a request like \"more edge rendering, less crypto\": call get-interests, rewrite the text yourself to include the change (keep the user's own wording and everything they didn't ask to change), then pass the full new text here. Saving changes recent scores to stale so the next update re-scores them. Tell the user what you changed.",
  schema: z.object({
    profileText: z
      .string()
      .max(MAX_PROFILE_CHARS + 500)
      .describe(`The complete new profile, first person, plain language, ${MIN_PROFILE_CHARS}-${MAX_PROFILE_CHARS} characters. It replaces the old text, so include everything that should stay.`),
  }),
  run: async ({ profileText }) => {
    const ownerEmail = getRequestUserEmail();
    if (!ownerEmail) fail("Sign in required", { errorCode: "unauthorized", statusCode: 401 });
    return updateInterests({ ownerEmail, orgId: getRequestOrgId() ?? null, profileText });
  },
});
