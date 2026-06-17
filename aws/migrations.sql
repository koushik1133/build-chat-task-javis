-- Javis production migrations
-- Run these line-by-line in Aurora DSQL for an existing database.
-- DSQL is happiest with one DDL statement per transaction.

-- ── agents: editable templates / prompts ─────────────────────────────────────
ALTER TABLE agents ADD COLUMN IF NOT EXISTS system_prompt TEXT;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS template_id TEXT;

-- ── automations: Kanban + scheduled workflows ────────────────────────────────
ALTER TABLE automations ADD COLUMN IF NOT EXISTS kanban_label TEXT;
ALTER TABLE automations ADD COLUMN IF NOT EXISTS action_config TEXT;
ALTER TABLE automations ADD COLUMN IF NOT EXISTS last_result TEXT;
ALTER TABLE automations ADD COLUMN IF NOT EXISTS schedule_time TEXT;
ALTER TABLE automations ADD COLUMN IF NOT EXISTS schedule_timezone TEXT;
ALTER TABLE automations ADD COLUMN IF NOT EXISTS schedule_days TEXT;
ALTER TABLE automations ADD COLUMN IF NOT EXISTS last_scheduled_date TEXT;

-- ── production board: richer cards ───────────────────────────────────────────
ALTER TABLE production_tasks ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE production_tasks ADD COLUMN IF NOT EXISTS due_date DATE;
ALTER TABLE production_tasks ADD COLUMN IF NOT EXISTS tags TEXT;
ALTER TABLE production_tasks ADD COLUMN IF NOT EXISTS assignee TEXT;
ALTER TABLE production_tasks ADD COLUMN IF NOT EXISTS automation TEXT;
ALTER TABLE production_tasks ADD COLUMN IF NOT EXISTS approved_at TIMESTAMP;

-- ── user integrations: verified email delivery ───────────────────────────────
ALTER TABLE user_integrations ADD COLUMN IF NOT EXISTS slack_channel_name TEXT;
ALTER TABLE user_integrations ADD COLUMN IF NOT EXISTS slack_connected_at TIMESTAMP;
ALTER TABLE user_integrations ADD COLUMN IF NOT EXISTS email_default_to TEXT;
ALTER TABLE user_integrations ADD COLUMN IF NOT EXISTS email_from_name TEXT;
ALTER TABLE user_integrations ADD COLUMN IF NOT EXISTS email_connected_at TIMESTAMP;
ALTER TABLE user_integrations ADD COLUMN IF NOT EXISTS email_verified BOOLEAN;
ALTER TABLE user_integrations ADD COLUMN IF NOT EXISTS email_pending TEXT;
ALTER TABLE user_integrations ADD COLUMN IF NOT EXISTS email_verify_code TEXT;
ALTER TABLE user_integrations ADD COLUMN IF NOT EXISTS email_verify_expires TIMESTAMP;
ALTER TABLE user_integrations ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP;

-- ── build/site analytics support ─────────────────────────────────────────────
ALTER TABLE files ADD COLUMN IF NOT EXISTS storage_path TEXT;
ALTER TABLE files ADD COLUMN IF NOT EXISTS chunk_count INTEGER;

-- Backfill defaults for nullable columns added above.
UPDATE automations SET action_config = '{}' WHERE action_config IS NULL;
UPDATE automations SET schedule_timezone = 'America/Chicago' WHERE schedule_timezone IS NULL AND schedule_time IS NOT NULL;
UPDATE automations SET schedule_days = 'daily' WHERE schedule_days IS NULL AND schedule_time IS NOT NULL;
UPDATE production_tasks SET tags = '[]' WHERE tags IS NULL;
UPDATE user_integrations SET email_verified = FALSE WHERE email_verified IS NULL;
UPDATE user_integrations SET updated_at = NOW() WHERE updated_at IS NULL;
UPDATE files SET chunk_count = 0 WHERE chunk_count IS NULL;
