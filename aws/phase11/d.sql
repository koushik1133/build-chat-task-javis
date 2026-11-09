-- Phase 11 lane D: country tax compliance (GST / VAT / US sales tax, e-invoicing, filings)
CREATE TABLE IF NOT EXISTS tax_profiles (
  user_id             TEXT PRIMARY KEY,
  regime              TEXT NOT NULL DEFAULT 'generic',
  country             TEXT,
  state_province      TEXT,
  registration_number TEXT,
  registration_type   TEXT NOT NULL DEFAULT 'regular',
  filing_frequency    TEXT NOT NULL DEFAULT 'quarterly',
  e_invoicing_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  settings            TEXT NOT NULL DEFAULT '{}',
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE crm_contacts ADD COLUMN IF NOT EXISTS tax_country TEXT;

ALTER TABLE crm_contacts ADD COLUMN IF NOT EXISTS tax_state TEXT;

ALTER TABLE crm_contacts ADD COLUMN IF NOT EXISTS tax_registration_type TEXT;

ALTER TABLE products ADD COLUMN IF NOT EXISTS hsn_sac_code TEXT;

ALTER TABLE products ADD COLUMN IF NOT EXISTS tax_category TEXT;

ALTER TABLE quotes ADD COLUMN IF NOT EXISTS place_of_supply TEXT;

ALTER TABLE quotes ADD COLUMN IF NOT EXISTS reverse_charge BOOLEAN;

ALTER TABLE quotes ADD COLUMN IF NOT EXISTS tax_regime TEXT;

ALTER TABLE invoices ADD COLUMN IF NOT EXISTS place_of_supply TEXT;

ALTER TABLE invoices ADD COLUMN IF NOT EXISTS reverse_charge BOOLEAN;

ALTER TABLE invoices ADD COLUMN IF NOT EXISTS tax_regime TEXT;

ALTER TABLE invoices ADD COLUMN IF NOT EXISTS e_invoice_ref TEXT;

ALTER TABLE invoices ADD COLUMN IF NOT EXISTS e_invoice_status TEXT;

CREATE TABLE IF NOT EXISTS tax_filings (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL,
  regime        TEXT NOT NULL,
  period_start  TIMESTAMPTZ NOT NULL,
  period_end    TIMESTAMPTZ NOT NULL,
  status        TEXT NOT NULL DEFAULT 'draft',
  totals        TEXT NOT NULL DEFAULT '{}',
  report_hash   TEXT,
  filed_ref     TEXT,
  filed_at      TIMESTAMPTZ,
  notes         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX ASYNC IF NOT EXISTS idx_tax_filings_user_period ON tax_filings (user_id, period_start);

CREATE TABLE IF NOT EXISTS e_invoices (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL,
  invoice_id    TEXT NOT NULL,
  format        TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'draft',
  payload       TEXT,
  payload_hash  TEXT,
  provider_ref  TEXT,
  error         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX ASYNC IF NOT EXISTS uq_e_invoices_invoice_format ON e_invoices (invoice_id, format);

CREATE INDEX ASYNC IF NOT EXISTS idx_e_invoices_user_created ON e_invoices (user_id, created_at);

CREATE TABLE IF NOT EXISTS tax_exemptions (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL,
  contact_id      TEXT NOT NULL,
  jurisdiction    TEXT NOT NULL,
  certificate_ref TEXT,
  expires_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX ASYNC IF NOT EXISTS idx_tax_exemptions_user_contact ON tax_exemptions (user_id, contact_id);
