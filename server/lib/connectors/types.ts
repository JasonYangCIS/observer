import type { FetchText, DomainPolicy } from "../safe-fetch.js";
import type { schema } from "../../db/index.js";

export type SourceRow = typeof schema.sources.$inferSelect;

/** One story from a source, normalized across connectors. */
export interface NormalizedItem {
  externalId: string;
  url: string;
  discussionUrl?: string;
  /** https thumbnail URL from the source, when it provides one. */
  imageUrl?: string;
  title: string;
  author?: string;
  /** ISO-8601 timestamp, when the source provides one. */
  postedAt?: string;
  /** Source-specific engagement numbers (points, comments, ...). */
  metrics: Record<string, number>;
}

export interface ConnectorContext {
  fetchText: FetchText;
  policy: DomainPolicy;
}

/**
 * Common interface for MCP, API, feed, and scrape connectors. Connectors only
 * fetch and normalize; storage and health tracking live in the fetch-source
 * action. All content they read is untrusted data.
 */
export interface Connector {
  fetchItems(source: SourceRow, ctx: ConnectorContext): Promise<NormalizedItem[]>;
}
