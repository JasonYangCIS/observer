import { feedConnector } from "./feed.js";
import { hnConnector } from "./hn.js";
import type { Connector, SourceRow } from "./types.js";

export type { Connector, ConnectorContext, NormalizedItem, SourceRow } from "./types.js";

/**
 * Resolve the connector for a source. MCP and scrape connectors are part of the
 * interface but not implemented until a later phase.
 */
export function getConnector(source: SourceRow): Connector {
  switch (source.connector) {
    case "api":
      if (source.type === "hn") return hnConnector;
      throw new Error(`No API connector for source type "${source.type}"`);
    case "feed":
      return feedConnector;
    case "mcp":
    case "scrape":
      throw new Error(`The ${source.connector} connector is not implemented yet`);
    default:
      throw new Error(`Unknown connector "${source.connector}"`);
  }
}
