import { feedConnector } from "./feed.js";
import { devtoConnector } from "./devto.js";
import { githubConnector } from "./github.js";
import { hnConnector } from "./hn.js";
import { lobstersConnector } from "./lobsters.js";
import type { Connector, SourceRow } from "./types.js";

export type { Connector, ConnectorContext, NormalizedItem, SourceRow } from "./types.js";

/** Official-API connectors by source type. Feed sources (rss, reddit, producthunt) all use the feed connector. */
const API_CONNECTORS: Record<string, Connector> = {
  hn: hnConnector,
  lobsters: lobstersConnector,
  devto: devtoConnector,
  github: githubConnector,
};

/**
 * Resolve the connector for a source. MCP and scrape connectors are part of the
 * interface but not implemented until a later phase.
 */
export function getConnector(source: SourceRow): Connector {
  switch (source.connector) {
    case "api": {
      const connector = API_CONNECTORS[source.type];
      if (connector) return connector;
      throw new Error(`No API connector for source type "${source.type}"`);
    }
    case "feed":
      return feedConnector;
    case "mcp":
    case "scrape":
      throw new Error(`The ${source.connector} connector is not implemented yet`);
    default:
      throw new Error(`Unknown connector "${source.connector}"`);
  }
}
