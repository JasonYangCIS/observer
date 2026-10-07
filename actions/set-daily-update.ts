import { z } from "zod";
import { defineAction, fail } from "@agent-native/core/action";
import { getRequestOrgId, getRequestUserEmail } from "@agent-native/core/server";
import { getDailyUpdate, setDailyUpdate } from "../server/lib/daily-update.js";

export default defineAction({
  description:
    "Turn the daily feed update on or off, and set when it runs. When on, an agent run fetches the user's sources and summarizes and scores up to 15 new items each day at the chosen local hour. Omit hour and timezone to keep the current ones (default 7 AM UTC). Check the outcome later with get-daily-update.",
  schema: z.object({
    enabled: z.boolean().describe("true to run the update every day, false to pause it"),
    hour: z.number().int().min(0).max(23).optional().describe("Local hour 0-23 to run at (default: keep the current hour, or 7)"),
    timezone: z.string().max(64).optional().describe('IANA time zone such as "America/Los_Angeles" (default: keep the current one, or UTC)'),
  }),
  run: async ({ enabled, hour, timezone }) => {
    const ownerEmail = getRequestUserEmail();
    if (!ownerEmail) fail("Sign in required", { errorCode: "unauthorized", statusCode: 401 });
    const current = await getDailyUpdate(ownerEmail);
    return setDailyUpdate({
      ownerEmail,
      orgId: getRequestOrgId() ?? null,
      enabled,
      hour: hour ?? current.hour,
      timezone: timezone ?? current.timezone,
    });
  },
});
