import { z } from "zod";
import { defineAction, fail } from "@agent-native/core/action";
import { getRequestOrgId, getRequestUserEmail } from "@agent-native/core/server";
import { importOpml } from "../server/lib/sources.js";

export default defineAction({
  description:
    "Add every feed in an OPML export (the file a feed reader exports) as an RSS source. Pass the file's text. Feeds already added, invalid or non-http(s) links, and feeds past the 50-source limit are skipped and counted in the result. Does not fetch anything; use fetch-source or Update feed afterwards.",
  schema: z.object({
    opml: z.string().min(1).max(500_000).describe("The full text of the OPML file (up to 500 KB)"),
  }),
  run: async ({ opml }) => {
    const ownerEmail = getRequestUserEmail();
    if (!ownerEmail) fail("Sign in required", { errorCode: "unauthorized", statusCode: 401 });
    return importOpml({ ownerEmail, orgId: getRequestOrgId() ?? null, opml });
  },
});
