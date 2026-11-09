-- Phase 7 / Lane D: report builder, saved reports, schedules, dashboards, notification preferences
-- DSQL rules: no FKs, no triggers, JSON as TEXT, CREATE INDEX ASYNC, one statement per block, no DEFAULT on ADD COLUMN.

-- ── saved_reports: a report spec (dataset, filters, group-bys, measures) + chart config ──
CREATE TABLE IF NOT EXISTS saved_reports (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  name         TEXT NOT NULL,
  description  TEXT,
  spec         TEXT NOT NULL,                 -- JSON ReportSpec
  chart        TEXT,                          -- JSON {type: table|bar|line|pie|kpi, x, y, series}
  visibility   TEXT NOT NULL DEFAULT 'org',   -- private|org
  created_by   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX ASYNC IF NOT EXISTS idx_saved_reports_user ON saved_reports (user_id, updated_at);

-- ── report_schedules: deliver a saved report on a cadence ──
CREATE TABLE IF NOT EXISTS report_schedules (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL,
  report_id     TEXT NOT NULL,
  cadence       TEXT NOT NULL DEFAULT 'weekly',  -- daily|weekly|monthly
  hour          INTEGER NOT NULL DEFAULT 8,      -- 0-23 in the org timezone
  weekday       INTEGER,                         -- 0 (Sun) - 6, weekly only
  day_of_month  INTEGER,                         -- 1-28, monthly only
  recipients    TEXT NOT NULL DEFAULT '[]',      -- JSON string[] of emails
  format        TEXT NOT NULL DEFAULT 'inline',  -- csv|pdf|inline
  enabled       BOOLEAN NOT NULL DEFAULT TRUE,
  last_sent_at  TIMESTAMPTZ,
  next_run_at   TIMESTAMPTZ,
  created_by    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX ASYNC IF NOT EXISTS idx_report_schedules_due ON report_schedules (enabled, next_run_at);

CREATE INDEX ASYNC IF NOT EXISTS idx_report_schedules_user ON report_schedules (user_id, report_id);

-- ── dashboards: grid of report cards + built-in KPI tiles, optionally the default for a role ──
CREATE TABLE IF NOT EXISTS dashboards (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  name        TEXT NOT NULL,
  role        TEXT,                              -- owner|admin|manager|member|viewer or NULL (personal)
  layout      TEXT NOT NULL DEFAULT '[]',        -- JSON [{report_id|builtin, w, h, x, y}]
  is_default  BOOLEAN NOT NULL DEFAULT FALSE,
  created_by  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX ASYNC IF NOT EXISTS idx_dashboards_user_role ON dashboards (user_id, role, is_default);

-- ── notification_preferences: per member channel matrix, digest cadence and quiet hours ──
CREATE TABLE IF NOT EXISTS notification_preferences (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL,                -- org data id
  member_user_id  TEXT NOT NULL,                -- the member these prefs belong to
  email           TEXT,                         -- digest recipient (captured from the session when saved)
  channel_prefs   TEXT NOT NULL DEFAULT '{}',   -- JSON {category: {in_app, email, push, sms}}
  digest          TEXT NOT NULL DEFAULT 'off',  -- daily|weekly|off
  digest_hour     INTEGER NOT NULL DEFAULT 8,
  digest_weekday  INTEGER,                      -- 0-6, weekly only
  quiet_hours     TEXT,                         -- JSON {start: "22:00", end: "07:00"}
  last_digest_at  TIMESTAMPTZ,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX ASYNC IF NOT EXISTS idx_notification_preferences_member ON notification_preferences (user_id, member_user_id);
