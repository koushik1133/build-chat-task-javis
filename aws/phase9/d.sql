-- Phase 9 lane D: workspace snapshots (portable configuration templates) + application registry.
-- One statement per block (Aurora DSQL). No foreign keys.

CREATE TABLE IF NOT EXISTS snapshots (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL,
  name          TEXT NOT NULL,
  description   TEXT,
  sections      TEXT NOT NULL DEFAULT '[]',   -- JSON array of section keys included
  payload       TEXT NOT NULL,                -- the snapshot JSON document (schema: 1)
  sha256        TEXT NOT NULL,
  size_bytes    INTEGER NOT NULL DEFAULT 0,
  source_org_id TEXT,
  visibility    TEXT NOT NULL DEFAULT 'private', -- private | agency
  created_by    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX ASYNC IF NOT EXISTS snapshots_user_created_idx ON snapshots (user_id, created_at DESC);

CREATE INDEX ASYNC IF NOT EXISTS snapshots_user_visibility_idx ON snapshots (user_id, visibility);

CREATE TABLE IF NOT EXISTS snapshot_applications (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,                  -- target workspace data id
  snapshot_id TEXT,
  applied_by  TEXT,
  mode        TEXT NOT NULL DEFAULT 'skip_existing',
  plan        TEXT,                           -- JSON plan summary
  result      TEXT,                           -- JSON result summary (+ errors)
  status      TEXT NOT NULL DEFAULT 'applied', -- applied | partial | failed
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX ASYNC IF NOT EXISTS snapshot_applications_user_created_idx ON snapshot_applications (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS snapshot_objects (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  section      TEXT NOT NULL,
  natural_key  TEXT NOT NULL,
  object_id    TEXT NOT NULL,
  snapshot_sha TEXT,
  item_sha     TEXT,
  applied_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX ASYNC IF NOT EXISTS snapshot_objects_key_uniq ON snapshot_objects (user_id, section, natural_key);
