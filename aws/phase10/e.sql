-- Phase 10 lane E: power-user UX (recent items, favourites, inbox snooze)

CREATE TABLE IF NOT EXISTS recent_items (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL,            -- org data id
  member_user_id  TEXT NOT NULL,            -- the member who opened it
  kind            TEXT NOT NULL,
  entity_id       TEXT NOT NULL,
  title           TEXT NOT NULL,
  href            TEXT NOT NULL,
  opened_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Unique per org as well: page recents key on the href, which repeats across a member's orgs.
DROP INDEX IF EXISTS idx_recent_items_member_entity;
CREATE UNIQUE INDEX ASYNC IF NOT EXISTS idx_recent_items_org_member_entity ON recent_items (user_id, member_user_id, kind, entity_id);

CREATE INDEX ASYNC IF NOT EXISTS idx_recent_items_member_opened ON recent_items (user_id, member_user_id, opened_at);

CREATE TABLE IF NOT EXISTS favorites (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL,            -- org data id
  member_user_id  TEXT NOT NULL,
  kind            TEXT NOT NULL,            -- page | contact | order | ...
  entity_id       TEXT,                     -- NULL for pinned pages
  label           TEXT NOT NULL,
  href            TEXT NOT NULL,
  sort            INTEGER NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX ASYNC IF NOT EXISTS idx_favorites_member ON favorites (user_id, member_user_id, sort);

ALTER TABLE notification_outbox ADD COLUMN IF NOT EXISTS snoozed_until TIMESTAMPTZ;
