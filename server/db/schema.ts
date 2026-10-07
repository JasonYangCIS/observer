import { index, table, text, uniqueIndex, integer, boolean, doublePrecision, sql } from "@agent-native/core/db/schema";

// Every table carries owner_email (per-user scoping) and a nullable org_id so
// team features (Phase 5) don't require a rewrite. Written out per table so the
// doctor's scope check can see the columns.

const createdAt = () =>
  text("created_at")
    .notNull()
    .default(sql`now()`);

const updatedAt = () =>
  text("updated_at")
    .notNull()
    .default(sql`now()`);

export const sources = table(
  "sources",
  {
    id: text("id").primaryKey(),
    ownerEmail: text("owner_email").notNull(),
    orgId: text("org_id"),
    type: text("type").notNull(), // hn | reddit | rss | ...
    connector: text("connector").notNull(), // mcp | api | feed | scrape
    name: text("name").notNull(),
    config: text("config").notNull().default("{}"), // JSON: url, subreddit, MCP ref, ...
    enabled: boolean("enabled").notNull().default(true),
    origin: text("origin").notNull().default("user"), // user | agent_discovered
    status: text("status").notNull().default("approved"), // candidate | approved | rejected | disabled
    trustWeight: doublePrecision("trust_weight").notNull().default(1),
    discoveryReason: text("discovery_reason"),
    discoveredAt: text("discovered_at"),
    lastSuccessAt: text("last_success_at"),
    errorCount: integer("error_count").notNull().default(0),
    lastError: text("last_error"),
    createdAt: createdAt(),
  },
  (t) => [index("sources_owner_idx").on(t.ownerEmail)],
);

export const sourceSettings = table(
  "source_settings",
  {
    id: text("id").primaryKey(),
    ownerEmail: text("owner_email").notNull(),
    orgId: text("org_id"),
    mode: text("mode").notNull().default("trusted_only"), // trusted_only | autonomous | hybrid
    maxNewSourcesPerWeek: integer("max_new_sources_per_week").notNull().default(3),
    autoApprove: boolean("auto_approve").notNull().default(false),
    autoApproveThreshold: doublePrecision("auto_approve_threshold"),
    allowlistDomains: text("allowlist_domains").notNull().default("[]"), // JSON array
    denylistDomains: text("denylist_domains").notNull().default("[]"), // JSON array
    preferredCategories: text("preferred_categories").notNull().default("[]"), // JSON array
    scrapeAllowed: boolean("scrape_allowed").notNull().default(false),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("source_settings_owner_uidx").on(t.ownerEmail)],
);

export const mcpConnections = table(
  "mcp_connections",
  {
    id: text("id").primaryKey(),
    ownerEmail: text("owner_email").notNull(),
    orgId: text("org_id"),
    serverUrl: text("server_url").notNull(),
    name: text("name").notNull(),
    approvedByUser: boolean("approved_by_user").notNull().default(false),
    allowedTools: text("allowed_tools").notNull().default("[]"), // JSON array, read-only tools only
    lastCheckedAt: text("last_checked_at"),
    createdAt: createdAt(),
  },
  (t) => [index("mcp_connections_owner_idx").on(t.ownerEmail)],
);

export const items = table(
  "items",
  {
    id: text("id").primaryKey(),
    ownerEmail: text("owner_email").notNull(),
    orgId: text("org_id"),
    sourceId: text("source_id").notNull(),
    externalId: text("external_id").notNull(),
    url: text("url").notNull(),
    discussionUrl: text("discussion_url"),
    imageUrl: text("image_url"), // https thumbnail URL only; images themselves are never stored
    title: text("title").notNull(),
    author: text("author"),
    postedAt: text("posted_at"),
    rawMetrics: text("raw_metrics").notNull().default("{}"), // JSON: points, comments
    fetchedText: text("fetched_text"),
    fetchedTextHash: text("fetched_text_hash"),
    fetchStatus: text("fetch_status").notNull().default("pending"), // pending | ok | paywalled | failed
    fetchError: text("fetch_error"),
    fetchedAt: text("fetched_at"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("items_source_external_uidx").on(t.sourceId, t.externalId),
    index("items_owner_posted_idx").on(t.ownerEmail, t.postedAt),
  ],
);

export const summaries = table(
  "summaries",
  {
    id: text("id").primaryKey(),
    ownerEmail: text("owner_email").notNull(),
    orgId: text("org_id"),
    itemId: text("item_id").notNull(),
    summaryText: text("summary_text").notNull(),
    commentSynthesis: text("comment_synthesis"),
    citations: text("citations").notNull().default("[]"), // JSON: span-level refs into items.fetched_text
    model: text("model"),
    inputHash: text("input_hash"), // hash of fetched_text summarized; skip re-summarizing when unchanged
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("summaries_item_uidx").on(t.itemId)],
);

export const scores = table(
  "scores",
  {
    id: text("id").primaryKey(),
    ownerEmail: text("owner_email").notNull(),
    orgId: text("org_id"),
    itemId: text("item_id").notNull(),
    relevance: doublePrecision("relevance").notNull(), // to this user
    importance: doublePrecision("importance").notNull(), // general buzz
    reason: text("reason").notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("scores_owner_item_uidx").on(t.ownerEmail, t.itemId)],
);

export const interestProfiles = table(
  "interest_profiles",
  {
    id: text("id").primaryKey(),
    ownerEmail: text("owner_email").notNull(),
    orgId: text("org_id"),
    profileText: text("profile_text").notNull(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("interest_profiles_owner_uidx").on(t.ownerEmail)],
);

export const runs = table(
  "runs",
  {
    id: text("id").primaryKey(),
    ownerEmail: text("owner_email").notNull(),
    orgId: text("org_id"),
    kind: text("kind").notNull(), // ingest | summarize | score | health | digest
    sourceId: text("source_id"),
    startedAt: text("started_at").notNull().default(sql`now()`),
    finishedAt: text("finished_at"),
    status: text("status").notNull().default("running"), // running | ok | error
    itemsProcessed: integer("items_processed").notNull().default(0),
    error: text("error"),
  },
  (t) => [index("runs_owner_started_idx").on(t.ownerEmail, t.startedAt)],
);
