-- Phase 5 / Lane C: home dashboard, onboarding, demo data
-- DSQL rules: no FKs, no triggers, JSON as TEXT, CREATE INDEX ASYNC, one statement per block, no DEFAULT on ADD COLUMN.

-- Registry of rows created by the demo seeder so "Clear sample data" removes only those rows.
-- entity = contact|quote|invoice|booking|ticket|task|record|product|expense|time_entry|outbox|booking_type
CREATE TABLE IF NOT EXISTS demo_seed_rows (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  entity     TEXT NOT NULL,
  entity_id  TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX ASYNC IF NOT EXISTS idx_demo_seed_rows_user ON demo_seed_rows (user_id, entity);
