-- Phase 5 / Lane D: privacy, compliance, data lifecycle (DPDP / GDPR controls)
-- DSQL rules: no FKs, no triggers, no sequences, JSON as TEXT, ids TEXT PK,
-- CREATE INDEX ASYNC, one statement per block, no DEFAULT on ADD COLUMN.

-- Consent ledger: append-only, one row per grant/withdrawal per purpose.
-- Current state is derived (latest row wins), never stored as a boolean.
-- subject_kind 'tombstone' rows carry sha256(email|phone) in subject_id so an
-- erased subject's opt-out stays effective after their PII is gone.
CREATE TABLE IF NOT EXISTS consent_records (
  id            TEXT        NOT NULL DEFAULT gen_random_uuid()::text,
  user_id       TEXT        NOT NULL,            -- org data id (owner_user_id)
  subject_kind  TEXT        NOT NULL,            -- contact|lead|member|tombstone
  subject_id    TEXT        NOT NULL,
  purpose       TEXT        NOT NULL,            -- marketing_email|marketing_sms|marketing_voice|transactional|analytics|portal
  status        TEXT        NOT NULL,            -- granted|withdrawn
  source        TEXT        NOT NULL DEFAULT 'manual', -- form|portal|import|manual|api
  evidence      TEXT,                            -- JSON {ip, ua, text_version, notice_version, text}
  occurred_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (id)
);

CREATE INDEX ASYNC IF NOT EXISTS consent_records_subject ON consent_records(user_id, subject_kind, subject_id, purpose, occurred_at);

-- Versioned privacy notices. Rows are never updated: publishing creates a new version.
CREATE TABLE IF NOT EXISTS privacy_notices (
  id            TEXT        NOT NULL DEFAULT gen_random_uuid()::text,
  user_id       TEXT        NOT NULL,
  version       INTEGER     NOT NULL,
  locale        TEXT        NOT NULL DEFAULT 'en',
  body_md       TEXT        NOT NULL,
  published_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (id)
);

CREATE INDEX ASYNC IF NOT EXISTS privacy_notices_user_version ON privacy_notices(user_id, locale, version);

-- Data subject requests (access / erasure / correction / portability / nomination).
CREATE TABLE IF NOT EXISTS dsr_requests (
  id                 TEXT        NOT NULL DEFAULT gen_random_uuid()::text,
  user_id            TEXT        NOT NULL,
  subject_kind       TEXT        NOT NULL,       -- contact|lead
  subject_id         TEXT        NOT NULL,
  subject_email      TEXT,
  kind               TEXT        NOT NULL,       -- access|erasure|correction|portability|nomination
  status             TEXT        NOT NULL DEFAULT 'received', -- received|verifying|in_progress|completed|rejected
  source             TEXT        NOT NULL DEFAULT 'staff',    -- staff|portal|api|agent
  requested_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  due_at             TIMESTAMPTZ NOT NULL,
  verified_at        TIMESTAMPTZ,
  completed_at       TIMESTAMPTZ,
  handled_by         TEXT,
  notes              TEXT,
  export_token_hash  TEXT,                       -- sha256 of the verification OTP (same pattern as quote acceptance)
  otp_expires_at     TIMESTAMPTZ,
  otp_attempts       INTEGER     NOT NULL DEFAULT 0,
  reminded_at        TIMESTAMPTZ,                -- due-soon reminder sent
  result             TEXT,                       -- JSON summary of erasure / export fulfilment
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (id)
);

CREATE INDEX ASYNC IF NOT EXISTS dsr_requests_user_status ON dsr_requests(user_id, status, due_at);

CREATE INDEX ASYNC IF NOT EXISTS dsr_requests_subject ON dsr_requests(user_id, subject_kind, subject_id);

-- Retention policies: one row per (org, entity_kind).
CREATE TABLE IF NOT EXISTS retention_policies (
  id            TEXT        NOT NULL DEFAULT gen_random_uuid()::text,
  user_id       TEXT        NOT NULL,
  entity_kind   TEXT        NOT NULL,            -- tickets_closed|mail_bodies|leads_resolved|voice_recordings|outbox|audit_log
  keep_days     INTEGER     NOT NULL,
  action        TEXT        NOT NULL DEFAULT 'anonymize', -- anonymize|delete|archive
  enabled       BOOLEAN     NOT NULL DEFAULT FALSE,
  last_run_at   TIMESTAMPTZ,
  last_affected INTEGER,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (id)
);

CREATE UNIQUE INDEX ASYNC IF NOT EXISTS retention_policies_user_kind ON retention_policies(user_id, entity_kind);

-- Breach / security incident log with the 72-hour authority-notification clock.
CREATE TABLE IF NOT EXISTS security_incidents (
  id                     TEXT        NOT NULL DEFAULT gen_random_uuid()::text,
  user_id                TEXT        NOT NULL,
  title                  TEXT        NOT NULL,
  description            TEXT,
  severity               TEXT        NOT NULL DEFAULT 'medium', -- low|medium|high|critical
  status                 TEXT        NOT NULL DEFAULT 'open',   -- open|contained|notified|closed
  detected_at            TIMESTAMPTZ NOT NULL,
  contained_at           TIMESTAMPTZ,
  notified_authority_at  TIMESTAMPTZ,
  notified_subjects_at   TIMESTAMPTZ,
  affected_count         INTEGER,
  created_by             TEXT,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (id)
);

CREATE INDEX ASYNC IF NOT EXISTS security_incidents_user ON security_incidents(user_id, status, detected_at);

-- Consent checkbox text shown on the site's lead widget / booking forms.
ALTER TABLE sites ADD COLUMN IF NOT EXISTS consent_text TEXT;

-- Voice campaigns skip contacts without marketing_voice consent unless FALSE (NULL = TRUE).
ALTER TABLE voice_campaigns ADD COLUMN IF NOT EXISTS require_consent BOOLEAN;
