-- Phase 4 / Lane A: public REST API v1 + outbound webhooks
-- DSQL rules: no FKs, JSON as TEXT, CREATE INDEX ASYNC, one DDL per transaction.

-- Idempotency store for POST /api/v1/* with an `Idempotency-Key` header.
-- Rows older than 24h are ignored and lazily deleted.
CREATE TABLE IF NOT EXISTS api_idempotency (
  id            TEXT        NOT NULL DEFAULT gen_random_uuid()::text,
  user_id       TEXT        NOT NULL,
  key           TEXT        NOT NULL,
  request_hash  TEXT        NOT NULL,           -- sha256(method + path + body)
  status        TEXT        NOT NULL DEFAULT 'pending', -- pending|completed
  response_json TEXT,                           -- {"status":201,"body":{...}}
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (id)
);

CREATE UNIQUE INDEX ASYNC IF NOT EXISTS api_idempotency_user_key ON api_idempotency(user_id, key);

CREATE INDEX ASYNC IF NOT EXISTS api_idempotency_created ON api_idempotency(created_at);

-- Outbound webhook subscriptions (one row per endpoint).
CREATE TABLE IF NOT EXISTS webhook_subscriptions (
  id              TEXT        NOT NULL DEFAULT gen_random_uuid()::text,
  user_id         TEXT        NOT NULL,          -- org data id (owner_user_id)
  url             TEXT        NOT NULL,
  secret          TEXT        NOT NULL,          -- "v1:…" encrypted (secure-store) or "plain:…"
  event_types     TEXT        NOT NULL DEFAULT '["*"]', -- JSON array; "*" = everything
  active          BOOLEAN     NOT NULL DEFAULT TRUE,
  description     TEXT,
  created_by      TEXT,                          -- user id or "api_key:<id>"
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_success_at TIMESTAMPTZ,
  last_failure_at TIMESTAMPTZ,
  failure_count   INTEGER     NOT NULL DEFAULT 0, -- consecutive failures; 20 auto-disables
  PRIMARY KEY (id)
);

CREATE INDEX ASYNC IF NOT EXISTS webhook_subscriptions_user ON webhook_subscriptions(user_id, active);

-- One delivery attempt record per (subscription, event). Retried in place.
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id              TEXT        NOT NULL DEFAULT gen_random_uuid()::text,
  user_id         TEXT        NOT NULL,
  subscription_id TEXT        NOT NULL,
  event_id        TEXT,                          -- events.id (NULL for test pings)
  event_type      TEXT        NOT NULL,
  payload         TEXT        NOT NULL,          -- JSON body exactly as signed/sent
  status          TEXT        NOT NULL DEFAULT 'queued', -- queued|delivering|delivered|failed|dead
  attempts        INTEGER     NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  response_status INTEGER,
  response_ms     INTEGER,
  error           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  delivered_at    TIMESTAMPTZ,
  PRIMARY KEY (id)
);

CREATE INDEX ASYNC IF NOT EXISTS webhook_deliveries_due ON webhook_deliveries(status, next_attempt_at);

CREATE INDEX ASYNC IF NOT EXISTS webhook_deliveries_sub ON webhook_deliveries(subscription_id, created_at);

CREATE INDEX ASYNC IF NOT EXISTS webhook_deliveries_user ON webhook_deliveries(user_id, created_at);

-- Fan-out watermark: the last `events` row turned into deliveries.
CREATE TABLE IF NOT EXISTS webhook_cursors (
  name               TEXT        NOT NULL,       -- 'events'
  last_event_at      TIMESTAMPTZ,
  last_event_id      TEXT,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (name)
);

-- Keyset pagination for the public API reads (created_at DESC, id DESC).
CREATE INDEX ASYNC IF NOT EXISTS crm_contacts_user_created ON crm_contacts(user_id, created_at, id);

CREATE INDEX ASYNC IF NOT EXISTS events_user_created_id ON events(user_id, created_at, id);
