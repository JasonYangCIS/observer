import { z } from "zod";
import { defineAction, fail } from "@agent-native/core/action";
import { getRequestUserEmail } from "@agent-native/core/server";
import { listSources } from "../server/lib/sources.js";

export default defineAction({
  description:
    "List the signed-in user's sources (Hacker News, RSS/Atom feeds) with enabled state, health (last success, error count, last error), and how many items each has produced.",
  schema: z.object({}),
  http: { method: "GET" },
  readOnly: true,
  run: async () => {
    const ownerEmail = getRequestUserEmail();
    if (!ownerEmail) fail("Sign in required", { errorCode: "unauthorized", statusCode: 401 });
    return { sources: await listSources(ownerEmail) };
  },
});
