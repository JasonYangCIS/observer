import { z } from "zod";
import { defineAction, fail } from "@agent-native/core/action";
import { getRequestUserEmail } from "@agent-native/core/server";
import { getDailyUpdate } from "../server/lib/daily-update.js";

export default defineAction({
  description:
    "Show whether the daily feed update is on, when it runs (hour and time zone), when it runs next, and how the last run went (status and error). The update fetches sources, reads new articles, then summarizes and scores them.",
  schema: z.object({}),
  http: { method: "GET" },
  readOnly: true,
  run: async () => {
    const ownerEmail = getRequestUserEmail();
    if (!ownerEmail) fail("Sign in required", { errorCode: "unauthorized", statusCode: 401 });
    return getDailyUpdate(ownerEmail);
  },
});
