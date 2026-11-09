-- Phase 10 lane C: alerting (rules + events)

CREATE TABLE IF NOT EXISTS alert_rules (
  id            TEXT PRIMARY KEY,
  user_id       TEXT,                                  -- org data id; NULL = platform rule (operator)
  key           TEXT NOT NULL,                         -- stable rule key, e.g. outbox_failed
  name          TEXT NOT NULL,
  condition     TEXT NOT NULL,                         -- JSON {metric, op, threshold, window_min}
  channel_ids   TEXT NOT NULL DEFAULT '[]',            -- JSON array: chat_integrations ids or "email:<address>"
  enabled       BOOLEAN NOT NULL DEFAULT FALSE,
  last_fired_at TIMESTAMPTZ,
  last_eval_at  TIMESTAMPTZ,
  cooldown_min  INTEGER NOT NULL DEFAULT 60,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX ASYNC IF NOT EXISTS idx_alert_rules_user ON alert_rules (user_id, key);

CREATE INDEX ASYNC IF NOT EXISTS idx_alert_rules_enabled ON alert_rules (enabled, last_eval_at);

CREATE TABLE IF NOT EXISTS alert_events (
  id          TEXT PRIMARY KEY,
  user_id     TEXT,
  rule_id     TEXT NOT NULL,
  fired_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ,
  value       DOUBLE PRECISION,
  message     TEXT
);

CREATE INDEX ASYNC IF NOT EXISTS idx_alert_events_user ON alert_events (user_id, fired_at);

CREATE INDEX ASYNC IF NOT EXISTS idx_alert_events_rule ON alert_events (rule_id, resolved_at);
