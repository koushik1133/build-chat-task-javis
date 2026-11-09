-- Phase 8 / Lane C: projects (milestones, tasks with assignees/due dates, budgets vs actuals, timeline)
-- DSQL rules: no FKs, no triggers, JSON as TEXT, CREATE INDEX ASYNC, one statement per block, no DEFAULT on ADD COLUMN.
-- Lane A owns tasks.due_at / tasks.assignee_id / tasks.priority (not repeated here).

-- ── projects ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS projects (
  id                TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL,
  name              TEXT NOT NULL,
  code              TEXT,                           -- short label, e.g. PRJ-001
  description_md    TEXT,
  contact_id        TEXT,
  quote_id          TEXT,
  status            TEXT NOT NULL DEFAULT 'planning', -- planning|active|on_hold|done|cancelled
  starts_on         DATE,
  due_on            DATE,
  budget_minor      BIGINT NOT NULL DEFAULT 0,
  currency          TEXT NOT NULL DEFAULT 'USD',
  billing_mode      TEXT NOT NULL DEFAULT 'none',   -- fixed|hourly|none
  hourly_rate_minor BIGINT NOT NULL DEFAULT 0,
  owner_member_id   TEXT,                           -- membership user id of the project owner
  color             TEXT,
  archived_at       TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX ASYNC IF NOT EXISTS idx_projects_user_status ON projects (user_id, status, archived_at, due_on);

CREATE INDEX ASYNC IF NOT EXISTS idx_projects_user_created ON projects (user_id, created_at, id);

CREATE INDEX ASYNC IF NOT EXISTS idx_projects_quote ON projects (user_id, quote_id);

-- ── project_milestones ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS project_milestones (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  project_id   TEXT NOT NULL,
  name         TEXT NOT NULL,
  due_on       DATE,
  status       TEXT NOT NULL DEFAULT 'open',        -- open|done
  sort         INTEGER NOT NULL DEFAULT 0,
  completed_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX ASYNC IF NOT EXISTS idx_project_milestones_project ON project_milestones (user_id, project_id, sort);

CREATE INDEX ASYNC IF NOT EXISTS idx_project_milestones_due ON project_milestones (user_id, status, due_on);

-- ── project_members ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS project_members (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL,
  project_id     TEXT NOT NULL,
  member_user_id TEXT,                              -- org membership user id (nullable)
  staff_id       TEXT,                              -- workforce staff profile (nullable)
  role           TEXT NOT NULL DEFAULT 'member',    -- lead|member|viewer
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX ASYNC IF NOT EXISTS idx_project_members_project ON project_members (user_id, project_id);

CREATE INDEX ASYNC IF NOT EXISTS idx_project_members_member ON project_members (user_id, member_user_id);

-- ── tasks: project linkage, planning fields, overdue bookkeeping ─────────────
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS project_id TEXT;

ALTER TABLE tasks ADD COLUMN IF NOT EXISTS milestone_id TEXT;

ALTER TABLE tasks ADD COLUMN IF NOT EXISTS estimate_minutes INTEGER;

ALTER TABLE tasks ADD COLUMN IF NOT EXISTS sort INTEGER;

ALTER TABLE tasks ADD COLUMN IF NOT EXISTS depends_on TEXT;

ALTER TABLE tasks ADD COLUMN IF NOT EXISTS overdue_notified_at TIMESTAMPTZ;

CREATE INDEX ASYNC IF NOT EXISTS idx_tasks_project ON tasks (user_id, project_id, done);

CREATE INDEX ASYNC IF NOT EXISTS idx_tasks_overdue_sweep ON tasks (done, due_at, overdue_notified_at);

-- ── time_entries / expenses: direct project linkage (ref_kind='project' is kept too) ──
ALTER TABLE time_entries ADD COLUMN IF NOT EXISTS project_id TEXT;

CREATE INDEX ASYNC IF NOT EXISTS idx_time_entries_project ON time_entries (user_id, project_id);

ALTER TABLE expenses ADD COLUMN IF NOT EXISTS project_id TEXT;

CREATE INDEX ASYNC IF NOT EXISTS idx_expenses_project ON expenses (user_id, project_id);
