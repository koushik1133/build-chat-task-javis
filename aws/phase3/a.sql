-- Phase 3 / Lane A: configurable records + workflow primitive
CREATE TABLE IF NOT EXISTS record_types (
  id             TEXT        NOT NULL DEFAULT gen_random_uuid()::text,
  user_id        TEXT        NOT NULL,
  slug           TEXT        NOT NULL,
  name           TEXT        NOT NULL,
  icon           TEXT,
  description    TEXT,
  fields         TEXT        NOT NULL DEFAULT '[]', -- JSON array of field defs
  stages         TEXT        NOT NULL DEFAULT '[]', -- JSON array of {key,label,color}
  views          TEXT        NOT NULL DEFAULT '{}', -- JSON
  copilot_prompt TEXT,
  pack_slug      TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (id)
);

CREATE UNIQUE INDEX ASYNC IF NOT EXISTS record_types_user_slug ON record_types(user_id, slug);

CREATE TABLE IF NOT EXISTS records (
  id           TEXT        NOT NULL DEFAULT gen_random_uuid()::text,
  user_id      TEXT        NOT NULL,
  type_id      TEXT        NOT NULL,
  title        TEXT        NOT NULL,
  stage        TEXT        NOT NULL,
  data         TEXT        NOT NULL DEFAULT '{}', -- JSON object keyed by field key
  summary      TEXT,
  contact_id   TEXT,
  amount_minor BIGINT,
  currency     TEXT,
  due_at       TIMESTAMPTZ,
  assigned_to  TEXT,
  deleted_at   TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (id)
);

CREATE INDEX ASYNC IF NOT EXISTS records_user_type_stage ON records(user_id, type_id, stage);

CREATE INDEX ASYNC IF NOT EXISTS records_user_type_updated ON records(user_id, type_id, updated_at);

CREATE TABLE IF NOT EXISTS record_activity (
  id         TEXT        NOT NULL DEFAULT gen_random_uuid()::text,
  user_id    TEXT        NOT NULL,
  record_id  TEXT        NOT NULL,
  actor_id   TEXT,
  kind       TEXT        NOT NULL DEFAULT 'comment', -- created|moved|updated|comment|linked
  body       TEXT,
  diff       TEXT, -- JSON
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (id)
);

CREATE INDEX ASYNC IF NOT EXISTS record_activity_record ON record_activity(user_id, record_id, created_at);

CREATE TABLE IF NOT EXISTS record_links (
  id          TEXT        NOT NULL DEFAULT gen_random_uuid()::text,
  user_id     TEXT        NOT NULL,
  record_id   TEXT        NOT NULL,
  target_kind TEXT        NOT NULL, -- contact|task|quote|invoice|booking|record
  target_id   TEXT        NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (id)
);

CREATE INDEX ASYNC IF NOT EXISTS record_links_record ON record_links(user_id, record_id);
