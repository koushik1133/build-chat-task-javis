-- Phase 10 / Lane A: Aurora DSQL compatibility corrections.
-- DSQL rules: no FKs, no triggers, JSON as TEXT, CREATE INDEX ASYNC, one statement per block, no DEFAULT on ADD COLUMN.
-- Already-applied statements are hash-tracked and never edited in place; the corrections below supersede them.

-- ── invoice_payments: replace the partial unique index with a total one ──────
-- ref_key = provider_ref when present, otherwise the row id (so NULL provider_refs never collide).
-- Written by recordPayment / createPayLink in src/lib/money/invoices.ts. Legacy rows keep ref_key NULL
-- (NULLs are distinct in a unique index) and remain protected by the application-level lookup.
ALTER TABLE invoice_payments ADD COLUMN IF NOT EXISTS ref_key TEXT;

DROP INDEX IF EXISTS uq_invoice_payments_provider_ref;

CREATE UNIQUE INDEX ASYNC IF NOT EXISTS uq_invoice_payments_ref_key ON invoice_payments (invoice_id, provider, ref_key);

-- ── agency indexes created without ASYNC in the original migration ───────────
CREATE INDEX ASYNC IF NOT EXISTS agency_clients_user_id ON agency_clients(user_id);

CREATE INDEX ASYNC IF NOT EXISTS agency_employees_user_id ON agency_employees(user_id);

CREATE INDEX ASYNC IF NOT EXISTS agency_projects_user_id ON agency_projects(user_id);

CREATE INDEX ASYNC IF NOT EXISTS agency_projects_status ON agency_projects(status);

CREATE INDEX ASYNC IF NOT EXISTS agency_standups_user_id ON agency_daily_standups(user_id);

CREATE INDEX ASYNC IF NOT EXISTS agency_standups_risk ON agency_daily_standups(risk_level);

CREATE INDEX ASYNC IF NOT EXISTS agency_proposals_user_id ON agency_proposals(user_id);

CREATE INDEX ASYNC IF NOT EXISTS agency_client_audits_user_id ON agency_client_audits(user_id);
