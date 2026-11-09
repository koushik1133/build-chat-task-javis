-- Phase 6 / Lane A: billing depth (tax engine, dunning, recurring invoices, credit notes & refunds, statements, FX, OTP recipient binding)
-- DSQL rules: no FKs, no triggers, JSON as TEXT, CREATE INDEX ASYNC, one statement per block, no DEFAULT on ADD COLUMN.

-- ── tax_rates: per-org tax catalogue (rate_bp = basis points, 1000 = 10%) ────
CREATE TABLE IF NOT EXISTS tax_rates (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL,
  name          TEXT NOT NULL,
  rate_bp       INTEGER NOT NULL DEFAULT 0,
  kind          TEXT NOT NULL DEFAULT 'other',   -- vat|gst|sales|other
  jurisdiction  TEXT,
  compound      BOOLEAN NOT NULL DEFAULT FALSE,
  is_default    BOOLEAN NOT NULL DEFAULT FALSE,
  active        BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX ASYNC IF NOT EXISTS idx_tax_rates_user ON tax_rates (user_id, active, created_at);

-- Contacts: tax number + billing address (JSON TEXT) + reminder opt-out.
ALTER TABLE crm_contacts ADD COLUMN IF NOT EXISTS tax_number TEXT;

ALTER TABLE crm_contacts ADD COLUMN IF NOT EXISTS billing_address TEXT;

ALTER TABLE crm_contacts ADD COLUMN IF NOT EXISTS invoice_reminders_opt_out BOOLEAN;

-- Quotes / invoices store the tax breakdown by rate (JSON TEXT).
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS tax_breakdown TEXT;

ALTER TABLE invoices ADD COLUMN IF NOT EXISTS tax_breakdown TEXT;

-- Payment terms + dunning counters (due_at already exists on invoices).
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS terms_days INTEGER;

ALTER TABLE invoices ADD COLUMN IF NOT EXISTS reminder_count INTEGER;

ALTER TABLE invoices ADD COLUMN IF NOT EXISTS last_reminder_at TIMESTAMPTZ;

ALTER TABLE invoices ADD COLUMN IF NOT EXISTS schedule_id TEXT;

CREATE INDEX ASYNC IF NOT EXISTS idx_invoices_user_due ON invoices (user_id, status, due_at);

-- Refunds live on the payment row.
ALTER TABLE invoice_payments ADD COLUMN IF NOT EXISTS refunded_minor BIGINT;

ALTER TABLE invoice_payments ADD COLUMN IF NOT EXISTS refunded_at TIMESTAMPTZ;

ALTER TABLE invoice_payments ADD COLUMN IF NOT EXISTS refund_ref TEXT;

-- ── invoice_schedules: recurring invoices ────────────────────────────────────
CREATE TABLE IF NOT EXISTS invoice_schedules (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL,
  contact_id      TEXT,
  name            TEXT NOT NULL,
  items           TEXT NOT NULL DEFAULT '[]',   -- JSON line items
  currency        TEXT NOT NULL DEFAULT 'USD',
  interval        TEXT NOT NULL DEFAULT 'monthly', -- weekly|monthly|quarterly|yearly
  interval_count  INTEGER NOT NULL DEFAULT 1,
  day_of_month    INTEGER,
  next_run_at     TIMESTAMPTZ NOT NULL,
  end_at          TIMESTAMPTZ,
  auto_send       BOOLEAN NOT NULL DEFAULT FALSE,
  terms_days      INTEGER,
  notes           TEXT,
  status          TEXT NOT NULL DEFAULT 'active', -- active|paused|ended
  last_invoice_id TEXT,
  last_run_at     TIMESTAMPTZ,
  run_count       INTEGER NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX ASYNC IF NOT EXISTS idx_invoice_schedules_user ON invoice_schedules (user_id, created_at);

CREATE INDEX ASYNC IF NOT EXISTS idx_invoice_schedules_due ON invoice_schedules (status, next_run_at);

-- ── credit_notes ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS credit_notes (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL,
  invoice_id      TEXT,
  contact_id      TEXT,
  number          TEXT NOT NULL,                 -- CN-000001
  items           TEXT NOT NULL DEFAULT '[]',
  subtotal_minor  BIGINT NOT NULL DEFAULT 0,
  tax_minor       BIGINT NOT NULL DEFAULT 0,
  total_minor     BIGINT NOT NULL DEFAULT 0,
  tax_breakdown   TEXT,
  currency        TEXT NOT NULL DEFAULT 'USD',
  reason          TEXT,
  status          TEXT NOT NULL DEFAULT 'draft',  -- draft|issued|applied|refunded
  issued_at       TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX ASYNC IF NOT EXISTS idx_credit_notes_user ON credit_notes (user_id, created_at);

CREATE INDEX ASYNC IF NOT EXISTS idx_credit_notes_invoice ON credit_notes (invoice_id);

-- ── fx_rates: manual exchange rates (rate stored as decimal text) ────────────
CREATE TABLE IF NOT EXISTS fx_rates (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  base       TEXT NOT NULL,
  quote      TEXT NOT NULL,
  rate       TEXT NOT NULL,
  as_of      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX ASYNC IF NOT EXISTS idx_fx_rates_user_pair ON fx_rates (user_id, base, quote, as_of);

-- Share tokens can be bound to the recipient email (OTP must match).
ALTER TABLE share_tokens ADD COLUMN IF NOT EXISTS recipient TEXT;
