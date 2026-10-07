import { z } from "zod";
import { defineAction, fail } from "@agent-native/core/action";
import { getRequestOrgId, getRequestUserEmail } from "@agent-native/core/server";
import { SOURCE_KINDS, addSource, removeSource, updateSource } from "../server/lib/sources.js";

export default defineAction({
  description:
    'Add, update, or remove a source. operation "add": type "hn" (Hacker News top stories), "lobsters" (hottest), "devto" (top of the week; optional tag), "github" (popular new repositories this week; optional language), "reddit" (a subreddit via its public RSS feed; subreddit required; no scores), "producthunt" (public feed), or "rss" (any RSS/Atom feed; url required). operation "update": id plus enabled and/or name (enable/disable a source). operation "remove": id; also deletes the source\'s items, summaries, scores, feedback, and run history. Use list-sources to find ids. To add many feeds from an OPML file use import-opml.',
  schema: z.object({
    operation: z.enum(["add", "update", "remove"]).describe('"add", "update", or "remove"'),
    id: z.string().optional().describe('Source id; required for "update" and "remove"'),
    type: z.enum(SOURCE_KINDS).optional().describe('Source type for "add": hn, lobsters, devto, github, reddit, producthunt, or rss'),
    url: z.string().max(2048).optional().describe('Feed URL (http/https) for "add" with type "rss"'),
    subreddit: z.string().max(40).optional().describe('Subreddit name without "r/" for type "reddit", for example "programming"'),
    tag: z.string().max(40).optional().describe('Optional dev.to tag for type "devto", for example "webdev"'),
    language: z.string().max(40).optional().describe('Optional programming language for type "github", for example "TypeScript"'),
    name: z.string().max(120).optional().describe("Display name; defaults to a sensible one for the type"),
    limit: z.number().int().min(1).max(60).optional().describe('Items to fetch per run for the API sources (default 25-30, max 60)'),
    enabled: z.boolean().optional().describe('For "update": true to enable, false to disable'),
  }),
  run: async (args) => {
    const ownerEmail = getRequestUserEmail();
    if (!ownerEmail) fail("Sign in required", { errorCode: "unauthorized", statusCode: 401 });
    const orgId = getRequestOrgId() ?? null;

    switch (args.operation) {
      case "add":
        if (!args.type) fail('"type" is required to add a source', { errorCode: "invalid_input" });
        return {
          source: await addSource({
            ownerEmail, orgId, type: args.type, name: args.name, url: args.url, limit: args.limit,
            subreddit: args.subreddit, tag: args.tag, language: args.language,
          }),
        };
      case "update":
        if (!args.id) fail('"id" is required to update a source', { errorCode: "invalid_input" });
        return { source: await updateSource({ ownerEmail, id: args.id, enabled: args.enabled, name: args.name }) };
      case "remove":
        if (!args.id) fail('"id" is required to remove a source', { errorCode: "invalid_input" });
        return { removed: true, id: args.id, ...(await removeSource(ownerEmail, args.id)) };
    }
  },
});
