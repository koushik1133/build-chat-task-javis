-- Phase 8 / Lane D: marketing — audiences, templates, campaigns, recipients, sequences, link clicks.
-- Aurora DSQL dialect: no FKs, no triggers, no sequences; JSON as TEXT; one statement per block.

CREATE TABLE IF NOT EXISTS audiences (
  id           TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id      TEXT NOT NULL,
  name         TEXT NOT NULL,
  definition   TEXT NOT NULL DEFAULT '{}',   -- JSON {lifecycle[], tags[], q, consent_purpose, has_email, has_phone, last_activity_days, record_type, stage}
  is_dynamic   BOOLEAN NOT NULL DEFAULT TRUE,
  size_cache   INTEGER,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX ASYNC IF NOT EXISTS idx_audiences_user ON audiences (user_id, created_at);

CREATE TABLE IF NOT EXISTS email_templates (
  id           TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id      TEXT NOT NULL,
  name         TEXT NOT NULL,
  subject      TEXT NOT NULL DEFAULT '',
  preheader    TEXT,
  body_md      TEXT NOT NULL DEFAULT '',      -- markdown + {{merge}} fields
  category     TEXT NOT NULL DEFAULT 'general',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX ASYNC IF NOT EXISTS idx_email_templates_user ON email_templates (user_id, created_at);

CREATE TABLE IF NOT EXISTS campaigns (
  id                 TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id            TEXT NOT NULL,
  name               TEXT NOT NULL,
  channel            TEXT NOT NULL DEFAULT 'email',   -- email | sms
  audience_id        TEXT,
  template_id        TEXT,
  subject            TEXT,
  preheader          TEXT,
  body_md            TEXT NOT NULL DEFAULT '',
  from_name          TEXT,
  reply_to           TEXT,
  status             TEXT NOT NULL DEFAULT 'draft',   -- draft | scheduled | sending | sent | paused | cancelled
  schedule_at        TIMESTAMPTZ,
  sent_count         INTEGER NOT NULL DEFAULT 0,
  delivered_count    INTEGER NOT NULL DEFAULT 0,
  opened_count       INTEGER NOT NULL DEFAULT 0,
  clicked_count      INTEGER NOT NULL DEFAULT 0,
  bounced_count      INTEGER NOT NULL DEFAULT 0,
  unsubscribed_count INTEGER NOT NULL DEFAULT 0,
  skipped_count      INTEGER NOT NULL DEFAULT 0,
  created_by         TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at         TIMESTAMPTZ,
  finished_at        TIMESTAMPTZ
);

CREATE INDEX ASYNC IF NOT EXISTS idx_campaigns_user_status ON campaigns (user_id, status, created_at);

CREATE TABLE IF NOT EXISTS campaign_recipients (
  id           TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id      TEXT NOT NULL,
  campaign_id  TEXT NOT NULL,
  contact_id   TEXT NOT NULL,
  email        TEXT,
  phone        TEXT,
  status       TEXT NOT NULL DEFAULT 'queued',  -- queued | skipped_no_consent | sent | delivered | bounced | failed | unsubscribed
  outbox_id    TEXT,
  sent_at      TIMESTAMPTZ,
  opened_at    TIMESTAMPTZ,
  clicked_at   TIMESTAMPTZ,
  error        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (campaign_id, contact_id)
);

CREATE INDEX ASYNC IF NOT EXISTS idx_campaign_recipients_campaign_status ON campaign_recipients (campaign_id, status, created_at);

CREATE INDEX ASYNC IF NOT EXISTS idx_campaign_recipients_user ON campaign_recipients (user_id, status);

CREATE TABLE IF NOT EXISTS sequences (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id         TEXT NOT NULL,
  name            TEXT NOT NULL,
  trigger         TEXT NOT NULL DEFAULT 'manual',   -- manual | audience_join | event
  trigger_config  TEXT NOT NULL DEFAULT '{}',       -- JSON {audience_id?, event_type?}
  steps           TEXT NOT NULL DEFAULT '[]',       -- JSON [{delay_hours, channel, template_id?, subject?, body_md?}]
  status          TEXT NOT NULL DEFAULT 'active',   -- active | paused
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX ASYNC IF NOT EXISTS idx_sequences_user ON sequences (user_id, status);

CREATE TABLE IF NOT EXISTS sequence_enrollments (
  id             TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id        TEXT NOT NULL,
  sequence_id    TEXT NOT NULL,
  contact_id     TEXT NOT NULL,
  step_index     INTEGER NOT NULL DEFAULT 0,
  next_at        TIMESTAMPTZ,
  status         TEXT NOT NULL DEFAULT 'active',    -- active | done | exited
  exited_reason  TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (sequence_id, contact_id)
);

CREATE INDEX ASYNC IF NOT EXISTS idx_sequence_enrollments_due ON sequence_enrollments (status, next_at);

CREATE INDEX ASYNC IF NOT EXISTS idx_sequence_enrollments_user_seq ON sequence_enrollments (user_id, sequence_id, created_at);

CREATE TABLE IF NOT EXISTS link_clicks (
  id            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id       TEXT NOT NULL,
  campaign_id   TEXT NOT NULL,
  recipient_id  TEXT NOT NULL,
  url           TEXT NOT NULL,
  clicked_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX ASYNC IF NOT EXISTS idx_link_clicks_campaign ON link_clicks (campaign_id, clicked_at);
