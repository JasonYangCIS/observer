import { z } from "zod";
import { defineAction, fail } from "@agent-native/core/action";
import { getRequestOrgId, getRequestUserEmail } from "@agent-native/core/server";
import { getInterests } from "../server/lib/interests.js";

export default defineAction({
  description:
    "Read the user's interest profile: the plain-language text of what they follow and don't, when it last changed, whether it is still the default, and how many recent scores are now stale because of a change (they are re-scored on the next update). Read this before changing it with update-interests.",
  schema: z.object({}),
  http: { method: "GET" },
  readOnly: true,
  run: async () => {
    const ownerEmail = getRequestUserEmail();
    if (!ownerEmail) fail("Sign in required", { errorCode: "unauthorized", statusCode: 401 });
    return getInterests(ownerEmail, getRequestOrgId() ?? null);
  },
});
