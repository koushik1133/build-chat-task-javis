-- ==== PHASE 9 LANE C: calendar two-way sync + chat-app notifications ====

CREATE TABLE IF NOT EXISTS calendar_connections (
  id                   TEXT PRIMARY KEY,
  user_id              TEXT NOT NULL,
  provider             TEXT NOT NULL,                  -- google|outlook|simulated
  account_email        TEXT NOT NULL,
  auth                 TEXT,                           -- encrypted JSON (secure-store); NULL for simulated
  external_calendar_id TEXT,
  sync_cursor          TEXT,
  status               TEXT NOT NULL DEFAULT 'connected', -- connected|error|disabled
  last_sync_at         TIMESTAMPTZ,
  last_error           TEXT,
  settings             TEXT NOT NULL DEFAULT '{}',     -- JSON {push_bookings, pull_busy, calendar_id}
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX ASYNC IF NOT EXISTS idx_calendar_connections_user ON calendar_connections (user_id, created_at);

CREATE TABLE IF NOT EXISTS calendar_event_links (
  id               TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL,
  connection_id    TEXT NOT NULL,
  booking_id       TEXT NOT NULL,
  external_event_id TEXT NOT NULL,
  etag             TEXT,
  last_pushed_at   TIMESTAMPTZ
);

CREATE UNIQUE INDEX ASYNC IF NOT EXISTS idx_calendar_event_links_conn_booking ON calendar_event_links (connection_id, booking_id);

CREATE TABLE IF NOT EXISTS external_busy (
  id                TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL,
  connection_id     TEXT NOT NULL,
  external_event_id TEXT NOT NULL,
  starts_at         TIMESTAMPTZ NOT NULL,
  ends_at           TIMESTAMPTZ NOT NULL,
  summary_hash      TEXT,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX ASYNC IF NOT EXISTS idx_external_busy_conn_event ON external_busy (connection_id, external_event_id);

CREATE INDEX ASYNC IF NOT EXISTS idx_external_busy_user_range ON external_busy (user_id, starts_at);

CREATE TABLE IF NOT EXISTS calsync_sim_events (
  id            TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL,
  calendar_id   TEXT NOT NULL,
  title         TEXT,
  starts_at     TIMESTAMPTZ NOT NULL,
  ends_at       TIMESTAMPTZ NOT NULL,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX ASYNC IF NOT EXISTS idx_calsync_sim_events_conn ON calsync_sim_events (connection_id, calendar_id);

CREATE TABLE IF NOT EXISTS calsync_cursors (
  name          TEXT PRIMARY KEY,
  last_event_at TIMESTAMPTZ,
  last_event_id TEXT,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS chat_integrations (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL,
  provider       TEXT NOT NULL,                        -- slack|teams|discord|webhook
  name           TEXT NOT NULL,
  webhook_url_enc TEXT NOT NULL,
  channel_label  TEXT,
  events         TEXT NOT NULL DEFAULT '[]',           -- JSON array of event type patterns
  enabled        BOOLEAN NOT NULL DEFAULT TRUE,
  last_status    TEXT,
  last_error     TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX ASYNC IF NOT EXISTS idx_chat_integrations_user ON chat_integrations (user_id, created_at);

CREATE TABLE IF NOT EXISTS chat_cursors (
  name          TEXT PRIMARY KEY,
  last_event_at TIMESTAMPTZ,
  last_event_id TEXT,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
