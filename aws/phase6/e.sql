-- Phase 6 lane E: embeddable widgets (web chat sessions + per-site widget config)

CREATE TABLE IF NOT EXISTS chat_sessions (
  id                 TEXT PRIMARY KEY,
  user_id            TEXT NOT NULL,
  site_id            TEXT NOT NULL,
  visitor_id         TEXT,
  session_token_hash TEXT NOT NULL,
  conversation_id    TEXT,
  contact_id         TEXT,
  lead_id            TEXT,
  status             TEXT NOT NULL DEFAULT 'open',   -- open | handed_off | closed
  page_url           TEXT,
  user_agent         TEXT,
  ip_hash            TEXT,
  expires_at         TIMESTAMPTZ NOT NULL,
  started_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  closed_at          TIMESTAMPTZ
);

CREATE INDEX ASYNC IF NOT EXISTS idx_chat_sessions_user_status ON chat_sessions (user_id, status, last_seen_at);

CREATE INDEX ASYNC IF NOT EXISTS idx_chat_sessions_token ON chat_sessions (session_token_hash);

CREATE INDEX ASYNC IF NOT EXISTS idx_chat_sessions_conversation ON chat_sessions (conversation_id);

ALTER TABLE sites ADD COLUMN IF NOT EXISTS widget_config TEXT;
