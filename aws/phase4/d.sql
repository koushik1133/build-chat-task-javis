-- ── Phase 4 / Lane D: email inbox sync + outbound voice campaigns ────────────
-- DSQL: one DDL per statement, no FKs, JSON as TEXT, CREATE INDEX ASYNC.

-- Mail accounts (OAuth / simulated). `auth` is encrypted via src/lib/secure-store.ts.
CREATE TABLE IF NOT EXISTS mail_accounts (
  id            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id       TEXT NOT NULL,
  provider      TEXT NOT NULL,                 -- gmail | outlook | imap | simulated
  email         TEXT NOT NULL,
  display_name  TEXT,
  auth          TEXT,                          -- encrypted JSON: {access_token, refresh_token, expires_at} or imap creds
  sync_cursor   TEXT,                          -- Gmail historyId / Graph deltaLink / IMAP uidnext
  status        TEXT NOT NULL DEFAULT 'connected', -- connected | error | disabled
  last_sync_at  TIMESTAMPTZ,
  last_error    TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX ASYNC IF NOT EXISTS idx_mail_accounts_user ON mail_accounts (user_id);

CREATE TABLE IF NOT EXISTS mail_messages (
  id                  TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id             TEXT NOT NULL,
  account_id          TEXT NOT NULL,
  provider_message_id TEXT NOT NULL,
  thread_id           TEXT,
  conversation_id     TEXT,                    -- messaging_conversations.id
  direction           TEXT NOT NULL DEFAULT 'in', -- in | out
  from_addr           TEXT,
  to_addrs            TEXT NOT NULL DEFAULT '[]', -- JSON array of addresses
  subject             TEXT,
  snippet             TEXT,
  body_text           TEXT,
  body_html           TEXT,
  received_at         TIMESTAMPTZ,
  is_read             BOOLEAN NOT NULL DEFAULT FALSE,
  labels              TEXT NOT NULL DEFAULT '[]', -- JSON array
  created_at          TIMESTAMPTZ DEFAULT NOW()
);
CREATE UNIQUE INDEX ASYNC IF NOT EXISTS uq_mail_messages_account_provider ON mail_messages (account_id, provider_message_id);
CREATE INDEX ASYNC IF NOT EXISTS idx_mail_messages_user_received ON mail_messages (user_id, received_at);
CREATE INDEX ASYNC IF NOT EXISTS idx_mail_messages_conversation ON mail_messages (conversation_id);

-- Email threads map onto the unified inbox; these columns let a thread be found again.
ALTER TABLE messaging_conversations ADD COLUMN IF NOT EXISTS thread_key TEXT;
ALTER TABLE messaging_conversations ADD COLUMN IF NOT EXISTS contact_id TEXT;
CREATE INDEX ASYNC IF NOT EXISTS idx_messaging_conv_thread ON messaging_conversations (user_id, thread_key);

-- Outbound voice campaigns
CREATE TABLE IF NOT EXISTS voice_campaigns (
  id            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id       TEXT NOT NULL,
  name          TEXT NOT NULL,
  script        TEXT NOT NULL,                 -- supports {{first_name}} {{full_name}} {{company}}
  voice         TEXT NOT NULL DEFAULT 'Polly.Joanna',
  status        TEXT NOT NULL DEFAULT 'draft', -- draft | scheduled | running | paused | done
  schedule_at   TIMESTAMPTZ,
  window_start  TEXT NOT NULL DEFAULT '09:00', -- HH:MM local to `timezone`
  window_end    TEXT NOT NULL DEFAULT '18:00',
  timezone      TEXT NOT NULL DEFAULT 'UTC',
  max_attempts  INTEGER NOT NULL DEFAULT 2,
  created_by    TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX ASYNC IF NOT EXISTS idx_voice_campaigns_user_status ON voice_campaigns (user_id, status);

CREATE TABLE IF NOT EXISTS voice_campaign_targets (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id         TEXT NOT NULL,
  campaign_id     TEXT NOT NULL,
  contact_id      TEXT,
  phone           TEXT NOT NULL,
  first_name      TEXT,
  status          TEXT NOT NULL DEFAULT 'queued', -- queued | calling | answered | voicemail | no_answer | failed | opted_out | done
  attempts        INTEGER NOT NULL DEFAULT 0,
  last_attempt_at TIMESTAMPTZ,
  call_sid        TEXT,
  outcome         TEXT,                        -- JSON: {digits, answered_by, duration_s, simulated, ...}
  created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX ASYNC IF NOT EXISTS idx_voice_targets_campaign_status ON voice_campaign_targets (campaign_id, status);
CREATE INDEX ASYNC IF NOT EXISTS idx_voice_targets_user ON voice_campaign_targets (user_id);

CREATE TABLE IF NOT EXISTS voice_calls (
  id            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id       TEXT NOT NULL,
  campaign_id   TEXT,
  target_id     TEXT,
  call_sid      TEXT,
  direction     TEXT NOT NULL DEFAULT 'outbound',
  status        TEXT NOT NULL DEFAULT 'queued', -- queued | in_progress | completed | no_answer | busy | failed | simulated
  duration_s    INTEGER,
  recording_url TEXT,
  transcript    TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX ASYNC IF NOT EXISTS idx_voice_calls_user_created ON voice_calls (user_id, created_at);
CREATE INDEX ASYNC IF NOT EXISTS idx_voice_calls_campaign ON voice_calls (campaign_id);

-- Do-not-call / do-not-contact list
CREATE TABLE IF NOT EXISTS contact_optouts (
  id          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id     TEXT NOT NULL,
  contact_id  TEXT,
  phone       TEXT,
  email       TEXT,
  channel     TEXT NOT NULL DEFAULT 'voice',  -- voice | sms | email | all
  reason      TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX ASYNC IF NOT EXISTS idx_contact_optouts_user_phone ON contact_optouts (user_id, phone);
