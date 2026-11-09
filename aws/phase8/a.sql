-- Phase 8 / Lane A: review-gap closures.
-- DSQL rules: no FKs, no triggers, JSON as TEXT, CREATE INDEX ASYNC, one statement per block, no DEFAULT on ADD COLUMN.

-- ── tasks: due date, assignee, priority (home overdue tile + API v1 + Projects) ──
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS due_at TIMESTAMPTZ;

ALTER TABLE tasks ADD COLUMN IF NOT EXISTS assignee_id TEXT;

ALTER TABLE tasks ADD COLUMN IF NOT EXISTS priority TEXT;

CREATE INDEX ASYNC IF NOT EXISTS idx_tasks_user_done_due ON tasks (user_id, done, due_at);

CREATE INDEX ASYNC IF NOT EXISTS idx_tasks_user_assignee ON tasks (user_id, assignee_id);

-- ── shifts: idempotent upcoming-shift reminders ──
ALTER TABLE shifts ADD COLUMN IF NOT EXISTS reminded_at TIMESTAMPTZ;
