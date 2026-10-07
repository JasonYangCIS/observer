import { z } from "zod";
import { defineAction, fail } from "@agent-native/core/action";
import { getRequestOrgId, getRequestUserEmail } from "@agent-native/core/server";
import { addSource, removeSource, updateSource } from "../server/lib/sources.js";

export default defineAction({
  description:
    'Add, update, or remove a source. operation "add": type "hn" (Hacker News top stories) or "rss" (RSS/Atom feed; url required). operation "update": id plus enabled and/or name (enable/disable a source). operation "remove": id; also deletes the source\'s items, summaries, scores, and run history. Use list-sources to find ids.',
  schema: z.object({
    operation: z.enum(["add", "update", "remove"]).describe('"add", "update", or "remove"'),
    id: z.string().optional().describe('Source id; required for "update" and "remove"'),
    type: z.enum(["hn", "rss"]).optional().describe('Source type for "add": "hn" or "rss"'),
    url: z.string().max(2048).optional().describe('Feed URL (http/https) for "add" with type "rss"'),
    name: z.string().max(120).optional().describe("Display name; defaults to the feed's hostname or Hacker News"),
    limit: z.number().int().min(1).max(60).optional().describe('Stories to fetch per run for type "hn" (default 30, max 60)'),
    enabled: z.boolean().optional().describe('For "update": true to enable, false to disable'),
  }),
  run: async (args) => {
    const ownerEmail = getRequestUserEmail();
    if (!ownerEmail) fail("Sign in required", { errorCode: "unauthorized", statusCode: 401 });
    const orgId = getRequestOrgId() ?? null;

    switch (args.operation) {
      case "add":
        if (!args.type) fail('"type" is required to add a source', { errorCode: "invalid_input" });
        return { source: await addSource({ ownerEmail, orgId, type: args.type, name: args.name, url: args.url, limit: args.limit }) };
      case "update":
        if (!args.id) fail('"id" is required to update a source', { errorCode: "invalid_input" });
        return { source: await updateSource({ ownerEmail, id: args.id, enabled: args.enabled, name: args.name }) };
      case "remove":
        if (!args.id) fail('"id" is required to remove a source', { errorCode: "invalid_input" });
        return { removed: true, id: args.id, ...(await removeSource(ownerEmail, args.id)) };
    }
  },
});
