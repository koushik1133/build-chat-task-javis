ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS principal_role TEXT;
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS principal_permissions TEXT;
ALTER TABLE sequence_enrollments ADD COLUMN IF NOT EXISTS last_step_sent_index INTEGER;
ALTER TABLE sequence_enrollments ADD COLUMN IF NOT EXISTS last_step_sent_at TIMESTAMPTZ;
