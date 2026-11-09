-- Phase 7 / Lane C: automations v2 (event-driven workflows with conditions, tool steps, templates, run history)
-- DSQL rules: no FKs, no triggers, JSON as TEXT, CREATE INDEX ASYNC, one statement per block, no DEFAULT on ADD COLUMN.

-- ── automations: v2 columns (legacy trigger_event/action_type rows keep working through legacyToV2) ──
ALTER TABLE automations ADD COLUMN IF NOT EXISTS trigger_type TEXT;

ALTER TABLE automations ADD COLUMN IF NOT EXISTS trigger_config TEXT;

ALTER TABLE automations ADD COLUMN IF NOT EXISTS conditions TEXT;

ALTER TABLE automations ADD COLUMN IF NOT EXISTS steps TEXT;

ALTER TABLE automations ADD COLUMN IF NOT EXISTS version INTEGER;

ALTER TABLE automations ADD COLUMN IF NOT EXISTS enabled BOOLEAN;

ALTER TABLE automations ADD COLUMN IF NOT EXISTS autonomy TEXT;

ALTER TABLE automations ADD COLUMN IF NOT EXISTS description TEXT;

ALTER TABLE automations ADD COLUMN IF NOT EXISTS template_key TEXT;

ALTER TABLE automations ADD COLUMN IF NOT EXISTS last_run_at TIMESTAMPTZ;

ALTER TABLE automations ADD COLUMN IF NOT EXISTS last_error TEXT;

ALTER TABLE automations ADD COLUMN IF NOT EXISTS error_count INTEGER;

ALTER TABLE automations ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;

UPDATE automations SET enabled = (status = 'active') WHERE enabled IS NULL;

UPDATE automations SET version = 1 WHERE version IS NULL;

UPDATE automations SET error_count = 0 WHERE error_count IS NULL;

CREATE INDEX ASYNC IF NOT EXISTS idx_automations_user_trigger ON automations (user_id, trigger_type, enabled);

-- ── automation_runs: one row per (automation × trigger event) ─────────────────
CREATE TABLE IF NOT EXISTS automation_runs (
  id               TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL,
  automation_id    TEXT NOT NULL,
  trigger_event_id TEXT,
  status           TEXT NOT NULL DEFAULT 'queued',   -- queued|running|waiting|done|failed|skipped
  context          TEXT,                             -- JSON {event, entity, org, steps}
  step_results     TEXT,                             -- JSON array of step outcomes
  step_index       INTEGER NOT NULL DEFAULT 0,
  approval_id      TEXT,
  error            TEXT,
  attempt          INTEGER NOT NULL DEFAULT 1,
  started_at       TIMESTAMPTZ,
  finished_at      TIMESTAMPTZ,
  resume_at        TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX ASYNC IF NOT EXISTS idx_automation_runs_user_auto ON automation_runs (user_id, automation_id, created_at);

CREATE INDEX ASYNC IF NOT EXISTS idx_automation_runs_status_resume ON automation_runs (status, resume_at, created_at);

CREATE INDEX ASYNC IF NOT EXISTS idx_automation_runs_approval ON automation_runs (approval_id);

CREATE UNIQUE INDEX ASYNC IF NOT EXISTS idx_automation_runs_auto_event ON automation_runs (automation_id, trigger_event_id);

-- ── automation_cursors: fan-out watermark (same pattern as webhook_cursors) ────
CREATE TABLE IF NOT EXISTS automation_cursors (
  name          TEXT PRIMARY KEY,
  last_event_at TIMESTAMPTZ,
  last_event_id TEXT,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
