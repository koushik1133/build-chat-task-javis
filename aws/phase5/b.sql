-- Phase 5 / Lane B: accounting live sync (QuickBooks Online, Xero, simulated).
-- Aurora DSQL: no FKs, no triggers, no sequences; JSON as TEXT; one statement per block.

CREATE TABLE IF NOT EXISTS accounting_connections (
  id            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id       TEXT NOT NULL,                    -- org data id
  provider      TEXT NOT NULL,                    -- quickbooks | xero | simulated
  auth          TEXT,                             -- encrypted JSON {access_token, refresh_token, expires_at}
  realm_id      TEXT,                             -- QBO company (realmId)
  tenant_id     TEXT,                             -- Xero tenant id
  company_name  TEXT,
  status        TEXT NOT NULL DEFAULT 'connected', -- connected | error | disabled
  sync_cursor   TEXT,                             -- pull watermark (ISO timestamp)
  last_sync_at  TIMESTAMPTZ,
  last_error    TEXT,
  settings      TEXT NOT NULL DEFAULT '{}',       -- JSON account mappings
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX ASYNC IF NOT EXISTS idx_accounting_connections_user ON accounting_connections (user_id);

CREATE TABLE IF NOT EXISTS accounting_links (
  id                TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id           TEXT NOT NULL,
  connection_id     TEXT NOT NULL,
  entity_kind       TEXT NOT NULL,                -- contact | invoice | payment | expense | product
  entity_id         TEXT NOT NULL,
  remote_id         TEXT,
  remote_updated_at TIMESTAMPTZ,
  remote_meta       TEXT,                         -- JSON: {syncToken} (QBO) etc.
  last_pushed_at    TIMESTAMPTZ,
  last_pulled_at    TIMESTAMPTZ,
  hash              TEXT,                         -- sha256 of the last pushed payload
  error             TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX ASYNC IF NOT EXISTS uq_accounting_links_entity ON accounting_links (connection_id, entity_kind, entity_id);

CREATE INDEX ASYNC IF NOT EXISTS idx_accounting_links_remote ON accounting_links (connection_id, entity_kind, remote_id);

CREATE INDEX ASYNC IF NOT EXISTS idx_accounting_links_user_kind ON accounting_links (user_id, entity_kind);

CREATE TABLE IF NOT EXISTS accounting_sync_log (
  id            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id       TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  direction     TEXT NOT NULL,                    -- push | pull
  entity_kind   TEXT,
  entity_id     TEXT,
  remote_id     TEXT,
  status        TEXT NOT NULL,                    -- ok | error | skipped
  message       TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX ASYNC IF NOT EXISTS idx_accounting_sync_log_conn ON accounting_sync_log (connection_id, created_at);

CREATE TABLE IF NOT EXISTS accounting_cursors (
  name          TEXT PRIMARY KEY,                 -- 'events'
  last_event_at TIMESTAMPTZ,
  last_event_id TEXT,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS accounting_sim_objects (
  id            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id       TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  kind          TEXT NOT NULL,                    -- Customer | Invoice | Payment | Purchase | Item
  remote_id     TEXT NOT NULL,
  source        TEXT NOT NULL DEFAULT 'push',     -- push (we sent it) | remote (created in the "accounting system")
  payload       TEXT NOT NULL,                    -- JSON exactly as it would be sent
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX ASYNC IF NOT EXISTS idx_accounting_sim_conn ON accounting_sim_objects (connection_id, kind, created_at);
