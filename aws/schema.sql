-- Aurora DSQL schema for Javis
-- Run each statement separately (one DDL per transaction in DSQL).
--
-- Key DSQL constraints applied:
--   - NO foreign key constraints (application-layer integrity instead)
--   - JSON/arrays stored as TEXT
--   - CREATE INDEX ASYNC only
--   - UUID primary keys (gen_random_uuid())
--   - No Supabase-specific types (auth.users, jsonb → TEXT)
--
-- Execute via psql or AWS Console Query Editor, one block at a time.
-- For an existing database, run aws/migrations.sql after this schema.

-- ── chats ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS chats (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    TEXT        NOT NULL,
  title      TEXT        NOT NULL DEFAULT 'New chat',
  created_at TIMESTAMP   NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP   NOT NULL DEFAULT NOW()
);

CREATE INDEX ASYNC ON chats (user_id, updated_at);

-- ── tasks ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tasks (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    TEXT        NOT NULL,
  chat_id    UUID,
  title      TEXT        NOT NULL,
  done       BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at TIMESTAMP   NOT NULL DEFAULT NOW()
);

CREATE INDEX ASYNC ON tasks (user_id, done, created_at);

-- ── files (metadata only; blobs in Supabase Storage) ─────────────────────────
CREATE TABLE IF NOT EXISTS files (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      TEXT        NOT NULL,
  name         TEXT        NOT NULL,
  mime         TEXT,
  size_bytes   BIGINT,
  storage_path TEXT,
  chunk_count  INTEGER     DEFAULT 0,
  created_at   TIMESTAMP   NOT NULL DEFAULT NOW()
);

CREATE INDEX ASYNC ON files (user_id, created_at);

-- ── sites ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sites (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    TEXT        NOT NULL,
  title      TEXT        NOT NULL DEFAULT 'Untitled site',
  persona    TEXT,
  plan       TEXT,          -- JSON.stringify(plan object)
  html       TEXT        NOT NULL DEFAULT '',
  created_at TIMESTAMP   NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP   NOT NULL DEFAULT NOW()
);

CREATE INDEX ASYNC ON sites (user_id, updated_at);

-- ── site_revisions ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS site_revisions (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id    UUID        NOT NULL,
  user_id    TEXT        NOT NULL,
  source     TEXT        NOT NULL CHECK (source IN ('initial','refine','feature','manual')),
  prompt     TEXT,
  html       TEXT        NOT NULL,
  created_at TIMESTAMP   NOT NULL DEFAULT NOW()
);

CREATE INDEX ASYNC ON site_revisions (site_id, created_at);

-- ── site_leads ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS site_leads (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id    UUID        NOT NULL,
  data       TEXT        NOT NULL,  -- JSON.stringify(form fields)
  created_at TIMESTAMP   NOT NULL DEFAULT NOW()
);

CREATE INDEX ASYNC ON site_leads (site_id, created_at);

-- ── agents ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS agents (
  id               UUID      PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          TEXT      NOT NULL,
  name             TEXT      NOT NULL,
  role             TEXT      NOT NULL DEFAULT 'General Agent',
  system_prompt    TEXT,
  template_id      TEXT,
  status           TEXT      NOT NULL DEFAULT 'idle' CHECK (status IN ('active','paused','idle')),
  tasks_completed  INTEGER   NOT NULL DEFAULT 0,
  created_at       TIMESTAMP NOT NULL DEFAULT NOW()
);

-- ALTER TABLE agents ADD COLUMN IF NOT EXISTS system_prompt TEXT;
-- ALTER TABLE agents ADD COLUMN IF NOT EXISTS template_id TEXT;

CREATE INDEX ASYNC ON agents (user_id, created_at);

-- ── agent_runs (stored output from scheduled/manual agent jobs) ───────────────
CREATE TABLE IF NOT EXISTS agent_runs (
  id             UUID      PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        TEXT      NOT NULL,
  agent_id       UUID      NOT NULL,
  automation_id  UUID,
  workflow_name  TEXT,
  prompt         TEXT,
  output         TEXT      NOT NULL,
  created_at     TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX ASYNC ON agent_runs (user_id, created_at);

-- ALTER TABLE agent_runs ... run CREATE TABLE above if missing

-- ── automations ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS automations (
  id             UUID      PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        TEXT      NOT NULL,
  name           TEXT      NOT NULL,
  trigger_event  TEXT      NOT NULL,
  action_type    TEXT      NOT NULL,
  kanban_label   TEXT,
  action_config  TEXT      NOT NULL DEFAULT '{}',
  last_result    TEXT,
  schedule_time  TEXT,
  schedule_timezone TEXT   DEFAULT 'America/Chicago',
  schedule_days  TEXT      DEFAULT 'daily',
  last_scheduled_date TEXT,
  status         TEXT      NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused')),
  run_count      INTEGER   NOT NULL DEFAULT 0,
  last_run       TIMESTAMP,
  created_at     TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Run if tables already exist (DSQL: no DEFAULT on ADD COLUMN — add plain, app fills values):
-- ALTER TABLE automations ADD COLUMN IF NOT EXISTS kanban_label TEXT;
-- ALTER TABLE automations ADD COLUMN IF NOT EXISTS action_config TEXT;
-- ALTER TABLE automations ADD COLUMN IF NOT EXISTS last_result TEXT;
-- ALTER TABLE automations ADD COLUMN IF NOT EXISTS schedule_time TEXT;
-- ALTER TABLE automations ADD COLUMN IF NOT EXISTS schedule_timezone TEXT;
-- ALTER TABLE automations ADD COLUMN IF NOT EXISTS schedule_days TEXT;
-- ALTER TABLE automations ADD COLUMN IF NOT EXISTS last_scheduled_date TEXT;

CREATE INDEX ASYNC ON automations (user_id, created_at);

-- ── notifications (in-app, from automations) ──────────────────────────────────
CREATE TABLE IF NOT EXISTS notifications (
  id         UUID      PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    TEXT      NOT NULL,
  title      TEXT      NOT NULL,
  body       TEXT,
  read       BOOLEAN   NOT NULL DEFAULT FALSE,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX ASYNC ON notifications (user_id, read, created_at);

-- ── user_integrations (one-time Slack / email setup per user) ─────────────────
CREATE TABLE IF NOT EXISTS user_integrations (
  user_id             TEXT      PRIMARY KEY,
  slack_webhook_url   TEXT,
  slack_channel_name  TEXT,
  slack_connected_at  TIMESTAMP,
  email_default_to    TEXT,
  email_from_name     TEXT,
  email_connected_at  TIMESTAMP,
  email_verified      BOOLEAN   NOT NULL DEFAULT FALSE,
  email_pending       TEXT,
  email_verify_code   TEXT,
  email_verify_expires TIMESTAMP,
  updated_at          TIMESTAMP NOT NULL DEFAULT NOW()
);

-- ALTER TABLE user_integrations ADD COLUMN IF NOT EXISTS email_verified BOOLEAN DEFAULT FALSE;
-- ALTER TABLE user_integrations ADD COLUMN IF NOT EXISTS email_pending TEXT;
-- ALTER TABLE user_integrations ADD COLUMN IF NOT EXISTS email_verify_code TEXT;
-- ALTER TABLE user_integrations ADD COLUMN IF NOT EXISTS email_verify_expires TIMESTAMP;

-- ── strategies ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS strategies (
  id         UUID      PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    TEXT      NOT NULL,
  title      TEXT      NOT NULL,
  type       TEXT      NOT NULL DEFAULT 'general',
  content    TEXT      NOT NULL DEFAULT '',
  status     TEXT      NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','archived')),
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX ASYNC ON strategies (user_id, created_at);

-- ── production_tasks ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS production_tasks (
  id          UUID      PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     TEXT      NOT NULL,
  title       TEXT      NOT NULL,
  status      TEXT      NOT NULL DEFAULT 'pending_approval',
  priority    TEXT      NOT NULL DEFAULT 'medium',
  description TEXT,
  due_date    DATE,
  tags        TEXT      NOT NULL DEFAULT '[]',
  assignee    TEXT,
  automation  TEXT,
  approved_at TIMESTAMP,
  created_at  TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Run this if the table already exists:
-- ALTER TABLE production_tasks ADD COLUMN IF NOT EXISTS description TEXT;

CREATE INDEX ASYNC ON production_tasks (user_id, status, created_at);

-- ── production_activity ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS production_activity (
  id         UUID      PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id    UUID      NOT NULL,
  user_id    TEXT      NOT NULL,
  action     TEXT      NOT NULL,
  details    TEXT      NOT NULL DEFAULT '{}',
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX ASYNC ON production_activity (task_id, created_at);

-- ── business_profile ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS business_profile (
  id              UUID      PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         TEXT      NOT NULL UNIQUE,
  company_name    TEXT      NOT NULL,
  industry        TEXT      NOT NULL,
  stage           TEXT      NOT NULL,
  team_size       TEXT      NOT NULL,
  geography       TEXT,
  product_desc    TEXT,
  target_market   TEXT,
  challenge       TEXT,
  revenue_range   TEXT,
  modules         TEXT      NOT NULL DEFAULT '[]', -- JSON array of enabled module keys
  completed       BOOLEAN   NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMP NOT NULL DEFAULT NOW()
);

-- ── board_configs ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS board_configs (
  id          UUID      PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     TEXT      NOT NULL,
  name        TEXT      NOT NULL DEFAULT 'My Board',
  template    TEXT      NOT NULL DEFAULT 'default',
  columns     TEXT      NOT NULL DEFAULT '[]', -- JSON: [{id, label, hitl, color}]
  card_fields TEXT      NOT NULL DEFAULT '[]', -- JSON: enabled field keys
  created_at  TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX ASYNC ON board_configs (user_id);

-- ── strategy_versions ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS strategy_versions (
  id          UUID      PRIMARY KEY DEFAULT gen_random_uuid(),
  strategy_id UUID      NOT NULL,
  user_id     TEXT      NOT NULL,
  content     TEXT      NOT NULL,
  created_at  TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX ASYNC ON strategy_versions (strategy_id, created_at);
