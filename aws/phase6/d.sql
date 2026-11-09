-- Phase 6 / Lane D — performance & scale: composite indexes + web_vitals.
-- DSQL rules: no FKs, no triggers, JSON as TEXT, CREATE INDEX ASYNC, one statement per block, no DEFAULT on ADD COLUMN.
-- Every index below matches a `WHERE user_id = $1 … ORDER BY …` list query; the query shape is documented in docs/PERFORMANCE.md.

-- tasks: GET /api/tasks keyset (user_id, created_at DESC, id DESC)
CREATE INDEX ASYNC IF NOT EXISTS idx_tasks_user_created_id ON tasks (user_id, created_at, id);

-- tickets: GET /api/helpdesk/tickets?cursor= keyset (user_id, created_at DESC, id DESC)
CREATE INDEX ASYNC IF NOT EXISTS idx_tickets_user_created_id ON tickets (user_id, created_at, id);

-- tickets: status filter + keyset (user_id, status, created_at)
CREATE INDEX ASYNC IF NOT EXISTS idx_tickets_user_status_created ON tickets (user_id, status, created_at);

-- tickets: default "priority" ordering falls back to updated_at within a user
CREATE INDEX ASYNC IF NOT EXISTS idx_tickets_user_updated ON tickets (user_id, updated_at);

-- records: GET /api/records/[type]?cursor= keyset (user_id, type_id, created_at DESC, id DESC)
CREATE INDEX ASYNC IF NOT EXISTS idx_records_user_type_created_id ON records (user_id, type_id, created_at, id);

-- products: GET /api/products?cursor= keyset (user_id, created_at DESC, id DESC)
CREATE INDEX ASYNC IF NOT EXISTS idx_products_user_created_id ON products (user_id, created_at, id);

-- expenses: GET /api/expenses?cursor= keyset (user_id, created_at DESC, id DESC)
CREATE INDEX ASYNC IF NOT EXISTS idx_expenses_user_created_id ON expenses (user_id, created_at, id);

-- time_entries: GET /api/time?cursor= keyset (user_id, created_at DESC, id DESC)
CREATE INDEX ASYNC IF NOT EXISTS idx_time_entries_user_created_id ON time_entries (user_id, created_at, id);

-- crm_contacts: default list ordering before a cursor is supplied (user_id, updated_at DESC)
CREATE INDEX ASYNC IF NOT EXISTS idx_crm_contacts_user_updated ON crm_contacts (user_id, updated_at);

-- crm_contacts: lifecycle filter + keyset
CREATE INDEX ASYNC IF NOT EXISTS idx_crm_contacts_user_lifecycle_created ON crm_contacts (user_id, lifecycle, created_at);

-- audit_log: GET /api/audit keyset incl. tie-break id
CREATE INDEX ASYNC IF NOT EXISTS idx_audit_log_user_created_id ON audit_log (user_id, created_at, id);

-- audit_log: entity filter + timeline
CREATE INDEX ASYNC IF NOT EXISTS idx_audit_log_user_entity_created ON audit_log (user_id, entity, created_at);

-- notification_outbox: GET /api/notifications/outbox timeline (user_id, created_at DESC, id DESC)
CREATE INDEX ASYNC IF NOT EXISTS idx_notification_outbox_user_created_id ON notification_outbox (user_id, created_at, id);

-- notification_outbox: bell query (user_id, channel='in_app', status='sent', read_at IS NULL) ordered by created_at
CREATE INDEX ASYNC IF NOT EXISTS idx_notification_outbox_user_channel_status_created ON notification_outbox (user_id, channel, status, created_at);

-- ai_credit_ledger: GET /api/ai/credits ledger keyset tie-break
CREATE INDEX ASYNC IF NOT EXISTS idx_ai_credit_ledger_user_created_id ON ai_credit_ledger (user_id, created_at, id);

-- memberships: requireScope() org switch lookup (user_id, org_id) — was only (user_id, status)
CREATE INDEX ASYNC IF NOT EXISTS idx_memberships_user_org ON memberships (user_id, org_id);

-- role_area_overrides: effectivePermissions() (org_id, role)
CREATE INDEX ASYNC IF NOT EXISTS idx_role_area_overrides_org_role ON role_area_overrides (org_id, role);

-- social_accounts: buildChannelNav() GROUP BY platform over connected accounts
CREATE INDEX ASYNC IF NOT EXISTS idx_social_accounts_user_connected ON social_accounts (user_id, connected, platform);

-- bookings: GET /api/bookings range scan with status filter
CREATE INDEX ASYNC IF NOT EXISTS idx_bookings_user_status_starts ON bookings (user_id, status, starts_at);

-- web_vitals: anonymous Core Web Vitals samples (no PII; global aggregate, not tenant-scoped)
CREATE TABLE IF NOT EXISTS web_vitals (
  id              TEXT PRIMARY KEY,
  path            TEXT NOT NULL,
  name            TEXT NOT NULL,
  value           DOUBLE PRECISION NOT NULL,
  rating          TEXT NOT NULL,
  navigation_type TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- web_vitals: p75-by-route aggregation window
CREATE INDEX ASYNC IF NOT EXISTS idx_web_vitals_path_name_created ON web_vitals (path, name, created_at);

-- web_vitals: retention prune
CREATE INDEX ASYNC IF NOT EXISTS idx_web_vitals_created ON web_vitals (created_at);
