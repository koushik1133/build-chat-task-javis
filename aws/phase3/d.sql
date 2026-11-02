-- Phase 3 / Lane D: CSV import jobs, web push subscriptions, crew links
-- DSQL: one DDL per transaction, CREATE INDEX ASYNC only, no foreign keys.

-- ── import_jobs: one row per CSV import (dry runs included) ──────────────────
CREATE TABLE IF NOT EXISTS import_jobs (
  id            TEXT        NOT NULL DEFAULT gen_random_uuid()::text,
  user_id       TEXT        NOT NULL,            -- org data id
  actor_id      TEXT,                            -- signed-in user who ran it
  target        TEXT        NOT NULL,            -- crm_contacts|leads|tasks|products|expenses
  status        TEXT        NOT NULL DEFAULT 'done', -- dry_run|done|failed
  dry_run       BOOLEAN     NOT NULL DEFAULT FALSE,
  row_count     INTEGER     NOT NULL DEFAULT 0,
  inserted      INTEGER     NOT NULL DEFAULT 0,
  skipped       INTEGER     NOT NULL DEFAULT 0,
  error_count   INTEGER     NOT NULL DEFAULT 0,
  mapping       TEXT        NOT NULL DEFAULT '{}', -- JSON {field: header}
  errors        TEXT        NOT NULL DEFAULT '[]', -- JSON array (first 50)
  file_name     TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (id)
);

CREATE INDEX ASYNC IF NOT EXISTS import_jobs_user_created ON import_jobs(user_id, created_at);

-- ── push_subscriptions: Web Push endpoints per device ────────────────────────
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id          TEXT        NOT NULL DEFAULT gen_random_uuid()::text,
  user_id     TEXT        NOT NULL,              -- org data id (deliverPushForUser key)
  member_id   TEXT,                              -- signed-in user who subscribed
  endpoint    TEXT        NOT NULL,
  keys        TEXT        NOT NULL,              -- JSON {p256dh, auth}
  user_agent  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (id)
);

CREATE UNIQUE INDEX ASYNC IF NOT EXISTS push_subscriptions_endpoint ON push_subscriptions(endpoint);

CREATE INDEX ASYNC IF NOT EXISTS push_subscriptions_user ON push_subscriptions(user_id);

-- ── crew links reuse share_tokens (kind = 'crew'); add a human label ─────────
ALTER TABLE share_tokens ADD COLUMN IF NOT EXISTS label TEXT;
