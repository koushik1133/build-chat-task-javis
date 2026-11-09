-- Phase 9 lane B: customer portal 2.0 — portal messaging

CREATE TABLE IF NOT EXISTS portal_messages (
  id               TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL,
  contact_id       TEXT NOT NULL,
  direction        TEXT NOT NULL,            -- in (from contact) | out (from staff)
  body             TEXT NOT NULL,
  author_member_id TEXT,                     -- staff member user id for direction = out
  read_at          TIMESTAMPTZ,              -- in: read by staff; out: read by contact
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX ASYNC IF NOT EXISTS idx_portal_messages_contact ON portal_messages (user_id, contact_id, created_at, id);

CREATE INDEX ASYNC IF NOT EXISTS idx_portal_messages_unread ON portal_messages (user_id, direction, read_at, created_at);
