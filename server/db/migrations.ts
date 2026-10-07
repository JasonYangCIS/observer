import type { MigrationEntry } from "@agent-native/core/db";

export const APP_MIGRATIONS_TABLE = "observer_migrations";

// Keep in sync with server/db/schema.ts. Every entry needs a unique `name`;
// never renumber or edit an entry that has shipped; add a new one instead.
// Migrations must be additive and backward compatible.
export const APP_MIGRATIONS: MigrationEntry[] = [
  {
    version: 1,
    name: "observer-sources",
    sql: `CREATE TABLE IF NOT EXISTS sources (
      id TEXT PRIMARY KEY,
      owner_email TEXT NOT NULL,
      org_id TEXT,
      type TEXT NOT NULL,
      connector TEXT NOT NULL,
      name TEXT NOT NULL,
      config TEXT NOT NULL DEFAULT '{}',
      enabled BOOLEAN NOT NULL DEFAULT true,
      origin TEXT NOT NULL DEFAULT 'user',
      status TEXT NOT NULL DEFAULT 'approved',
      trust_weight DOUBLE PRECISION NOT NULL DEFAULT 1,
      discovery_reason TEXT,
      discovered_at TEXT,
      last_success_at TEXT,
      error_count INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at TEXT NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS sources_owner_idx ON sources (owner_email);`,
  },
  {
    version: 2,
    name: "observer-source-settings",
    sql: `CREATE TABLE IF NOT EXISTS source_settings (
      id TEXT PRIMARY KEY,
      owner_email TEXT NOT NULL,
      org_id TEXT,
      mode TEXT NOT NULL DEFAULT 'trusted_only',
      max_new_sources_per_week INTEGER NOT NULL DEFAULT 3,
      auto_approve BOOLEAN NOT NULL DEFAULT false,
      auto_approve_threshold DOUBLE PRECISION,
      allowlist_domains TEXT NOT NULL DEFAULT '[]',
      denylist_domains TEXT NOT NULL DEFAULT '[]',
      preferred_categories TEXT NOT NULL DEFAULT '[]',
      scrape_allowed BOOLEAN NOT NULL DEFAULT false,
      updated_at TEXT NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS source_settings_owner_uidx ON source_settings (owner_email);`,
  },
  {
    version: 3,
    name: "observer-mcp-connections",
    sql: `CREATE TABLE IF NOT EXISTS mcp_connections (
      id TEXT PRIMARY KEY,
      owner_email TEXT NOT NULL,
      org_id TEXT,
      server_url TEXT NOT NULL,
      name TEXT NOT NULL,
      approved_by_user BOOLEAN NOT NULL DEFAULT false,
      allowed_tools TEXT NOT NULL DEFAULT '[]',
      last_checked_at TEXT,
      created_at TEXT NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS mcp_connections_owner_idx ON mcp_connections (owner_email);`,
  },
  {
    version: 4,
    name: "observer-items",
    sql: `CREATE TABLE IF NOT EXISTS items (
      id TEXT PRIMARY KEY,
      owner_email TEXT NOT NULL,
      org_id TEXT,
      source_id TEXT NOT NULL,
      external_id TEXT NOT NULL,
      url TEXT NOT NULL,
      discussion_url TEXT,
      title TEXT NOT NULL,
      author TEXT,
      posted_at TEXT,
      raw_metrics TEXT NOT NULL DEFAULT '{}',
      fetched_text TEXT,
      fetched_text_hash TEXT,
      fetch_status TEXT NOT NULL DEFAULT 'pending',
      fetch_error TEXT,
      fetched_at TEXT,
      created_at TEXT NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS items_source_external_uidx ON items (source_id, external_id);
    CREATE INDEX IF NOT EXISTS items_owner_posted_idx ON items (owner_email, posted_at);`,
  },
  {
    version: 5,
    name: "observer-summaries",
    sql: `CREATE TABLE IF NOT EXISTS summaries (
      id TEXT PRIMARY KEY,
      owner_email TEXT NOT NULL,
      org_id TEXT,
      item_id TEXT NOT NULL,
      summary_text TEXT NOT NULL,
      comment_synthesis TEXT,
      citations TEXT NOT NULL DEFAULT '[]',
      model TEXT,
      input_hash TEXT,
      created_at TEXT NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS summaries_item_uidx ON summaries (item_id);`,
  },
  {
    version: 6,
    name: "observer-scores",
    sql: `CREATE TABLE IF NOT EXISTS scores (
      id TEXT PRIMARY KEY,
      owner_email TEXT NOT NULL,
      org_id TEXT,
      item_id TEXT NOT NULL,
      relevance DOUBLE PRECISION NOT NULL,
      importance DOUBLE PRECISION NOT NULL,
      reason TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS scores_owner_item_uidx ON scores (owner_email, item_id);`,
  },
  {
    version: 7,
    name: "observer-interest-profiles",
    sql: `CREATE TABLE IF NOT EXISTS interest_profiles (
      id TEXT PRIMARY KEY,
      owner_email TEXT NOT NULL,
      org_id TEXT,
      profile_text TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS interest_profiles_owner_uidx ON interest_profiles (owner_email);`,
  },
  {
    version: 8,
    name: "observer-runs",
    sql: `CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      owner_email TEXT NOT NULL,
      org_id TEXT,
      kind TEXT NOT NULL,
      source_id TEXT,
      started_at TEXT NOT NULL DEFAULT now(),
      finished_at TEXT,
      status TEXT NOT NULL DEFAULT 'running',
      items_processed INTEGER NOT NULL DEFAULT 0,
      error TEXT
    );
    CREATE INDEX IF NOT EXISTS runs_owner_started_idx ON runs (owner_email, started_at);`,
  },
  {
    version: 9,
    name: "observer-feedback",
    sql: `CREATE TABLE IF NOT EXISTS feedback (
      id TEXT PRIMARY KEY,
      owner_email TEXT NOT NULL,
      org_id TEXT,
      item_id TEXT NOT NULL,
      signal TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS feedback_owner_item_signal_uidx ON feedback (owner_email, item_id, signal);
    CREATE INDEX IF NOT EXISTS feedback_owner_signal_created_idx ON feedback (owner_email, signal, created_at);`,
  },
  {
    version: 10,
    name: "observer-clusters",
    sql: `CREATE TABLE IF NOT EXISTS clusters (
      id TEXT PRIMARY KEY,
      owner_email TEXT NOT NULL,
      org_id TEXT,
      url_key TEXT NOT NULL,
      canonical_item_id TEXT NOT NULL,
      topic_label TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS clusters_owner_key_uidx ON clusters (owner_email, url_key);`,
  },
  {
    version: 11,
    name: "observer-cluster-items",
    sql: `CREATE TABLE IF NOT EXISTS cluster_items (
      id TEXT PRIMARY KEY,
      owner_email TEXT NOT NULL,
      org_id TEXT,
      cluster_id TEXT NOT NULL,
      item_id TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS cluster_items_owner_item_uidx ON cluster_items (owner_email, item_id);
    CREATE INDEX IF NOT EXISTS cluster_items_cluster_idx ON cluster_items (cluster_id);`,
  },
  {
    version: 12,
    name: "observer-sources-health",
    sql: `ALTER TABLE sources ADD COLUMN IF NOT EXISTS health_status TEXT;
    ALTER TABLE sources ADD COLUMN IF NOT EXISTS health_reason TEXT;
    ALTER TABLE sources ADD COLUMN IF NOT EXISTS health_checked_at TEXT;`,
  },
];
