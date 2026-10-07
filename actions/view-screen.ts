import { defineAction } from "@agent-native/core/action";
import { readAppState } from "@agent-native/core/application-state";
import { getRequestUserEmail } from "@agent-native/core/server";
import { z } from "zod";
import { listSources } from "../server/lib/sources.js";

export default defineAction({
  description:
    "See what the user is currently looking at on screen. Returns the current navigation state for the chat-first app. Always call this first before taking any action.",
  schema: z.object({}),
  http: false,
  readOnly: true,
  run: async () => {
    const navigation = await readAppState("navigation");

    const screen: Record<string, unknown> = {};
    if (navigation) screen.navigation = navigation;

    if ((navigation as { view?: string } | null)?.view === "sources") {
      const ownerEmail = getRequestUserEmail();
      if (ownerEmail) screen.sources = await listSources(ownerEmail);
    }

    if (Object.keys(screen).length === 0) {
      return "No application state found. Is the app running?";
    }
    return screen;
  },
});
