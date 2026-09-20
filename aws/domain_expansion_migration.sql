-- ─── KernelHub Universal Domain Expansion Migration ──────────────────────────
-- DSQL constraints: one DDL per transaction, no FK constraints, JSON as TEXT
-- Run each CREATE TABLE statement individually in separate transactions.

-- 1. User domain preferences (tracks which domain was selected during onboarding)
CREATE TABLE IF NOT EXISTS user_domain_preferences (
  id          TEXT        NOT NULL DEFAULT gen_random_uuid()::text,
  user_id     TEXT        NOT NULL,
  domain      TEXT        NOT NULL, -- 'agency' | 'healthcare' | 'education' | 'legal' | 'finance' | 'realestate' | 'ecommerce' | 'nonprofit' | 'business'
  features    TEXT        NOT NULL DEFAULT '[]', -- JSON array of enabled feature keys
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (id)
);

-- 2. Feature requests (global "Request a Feature" submissions)
CREATE TABLE IF NOT EXISTS domain_feature_requests (
  id           TEXT        NOT NULL DEFAULT gen_random_uuid()::text,
  user_id      TEXT        NOT NULL,
  domain       TEXT        NOT NULL DEFAULT 'general',
  title        TEXT        NOT NULL,
  description  TEXT        NOT NULL,
  category     TEXT        NOT NULL DEFAULT 'feature', -- 'feature' | 'integration' | 'improvement' | 'bug'
  status       TEXT        NOT NULL DEFAULT 'open',    -- 'open' | 'reviewing' | 'planned' | 'done'
  upvotes      INTEGER     NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (id)
);

-- 3. Universal CRM contacts
CREATE TABLE IF NOT EXISTS crm_contacts (
  id            TEXT        NOT NULL DEFAULT gen_random_uuid()::text,
  user_id       TEXT        NOT NULL,
  domain        TEXT        NOT NULL DEFAULT 'general',
  full_name     TEXT        NOT NULL,
  email         TEXT,
  phone         TEXT,
  company       TEXT,
  role          TEXT,
  tags          TEXT        NOT NULL DEFAULT '[]', -- JSON array
  lifecycle     TEXT        NOT NULL DEFAULT 'lead', -- 'lead' | 'prospect' | 'customer' | 'churned' | 'donor' | 'patient' | 'student'
  notes         TEXT,
  last_contact  TIMESTAMPTZ,
  deal_value    NUMERIC(12,2) DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (id)
);

-- 4. CRM activities log
CREATE TABLE IF NOT EXISTS crm_activities (
  id          TEXT        NOT NULL DEFAULT gen_random_uuid()::text,
  user_id     TEXT        NOT NULL,
  contact_id  TEXT        NOT NULL,
  type        TEXT        NOT NULL DEFAULT 'note', -- 'note' | 'call' | 'email' | 'meeting' | 'deal'
  title       TEXT        NOT NULL,
  body        TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (id)
);

-- 5. Healthcare: Patient Intake Records
CREATE TABLE IF NOT EXISTS healthcare_patients (
  id              TEXT        NOT NULL DEFAULT gen_random_uuid()::text,
  user_id         TEXT        NOT NULL,
  full_name       TEXT        NOT NULL,
  dob             TEXT,
  contact_email   TEXT,
  contact_phone   TEXT,
  chief_complaint TEXT,
  medical_history TEXT,
  medications     TEXT,
  allergies       TEXT,
  hipaa_consent   BOOLEAN     NOT NULL DEFAULT false,
  ai_summary      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (id)
);

-- 6. Education: Study Plans
CREATE TABLE IF NOT EXISTS education_study_plans (
  id           TEXT        NOT NULL DEFAULT gen_random_uuid()::text,
  user_id      TEXT        NOT NULL,
  subject      TEXT        NOT NULL,
  goal         TEXT        NOT NULL,
  duration_weeks INTEGER   NOT NULL DEFAULT 8,
  schedule     TEXT        NOT NULL DEFAULT '{}', -- JSON object
  ai_plan      TEXT,
  progress_pct INTEGER     NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (id)
);

-- 7. Legal: Case Files
CREATE TABLE IF NOT EXISTS legal_cases (
  id           TEXT        NOT NULL DEFAULT gen_random_uuid()::text,
  user_id      TEXT        NOT NULL,
  case_name    TEXT        NOT NULL,
  client_name  TEXT        NOT NULL,
  case_type    TEXT        NOT NULL DEFAULT 'civil', -- 'civil' | 'criminal' | 'corporate' | 'ip' | 'family'
  status       TEXT        NOT NULL DEFAULT 'active', -- 'active' | 'on_hold' | 'closed' | 'won' | 'settled'
  timeline     TEXT        NOT NULL DEFAULT '[]', -- JSON array of events
  billing_log  TEXT        NOT NULL DEFAULT '[]', -- JSON array
  ai_summary   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (id)
);

-- 8. Finance: Portfolio Items
CREATE TABLE IF NOT EXISTS finance_portfolios (
  id           TEXT        NOT NULL DEFAULT gen_random_uuid()::text,
  user_id      TEXT        NOT NULL,
  name         TEXT        NOT NULL,
  asset_type   TEXT        NOT NULL DEFAULT 'stock', -- 'stock' | 'crypto' | 'real_estate' | 'bond' | 'startup'
  ticker       TEXT,
  quantity     NUMERIC(18,8) DEFAULT 0,
  buy_price    NUMERIC(18,4) DEFAULT 0,
  current_price NUMERIC(18,4) DEFAULT 0,
  notes        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (id)
);

-- 9. Real Estate: Property Listings
CREATE TABLE IF NOT EXISTS realestate_properties (
  id           TEXT        NOT NULL DEFAULT gen_random_uuid()::text,
  user_id      TEXT        NOT NULL,
  address      TEXT        NOT NULL,
  city         TEXT,
  state        TEXT,
  property_type TEXT       NOT NULL DEFAULT 'residential', -- 'residential' | 'commercial' | 'land' | 'rental'
  price        NUMERIC(14,2) DEFAULT 0,
  status       TEXT        NOT NULL DEFAULT 'active', -- 'active' | 'pending' | 'sold' | 'rented'
  bedrooms     INTEGER,
  bathrooms    NUMERIC(4,1),
  sqft         INTEGER,
  ai_description TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (id)
);

-- 10. E-commerce: Products
CREATE TABLE IF NOT EXISTS ecommerce_products (
  id              TEXT        NOT NULL DEFAULT gen_random_uuid()::text,
  user_id         TEXT        NOT NULL,
  name            TEXT        NOT NULL,
  category        TEXT,
  sku             TEXT,
  price           NUMERIC(12,2) DEFAULT 0,
  stock_count     INTEGER     NOT NULL DEFAULT 0,
  stock_threshold INTEGER     NOT NULL DEFAULT 5, -- alert threshold
  ai_description  TEXT,
  review_summary  TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (id)
);

-- 11. Non-profit: Donor records
CREATE TABLE IF NOT EXISTS nonprofit_donors (
  id           TEXT        NOT NULL DEFAULT gen_random_uuid()::text,
  user_id      TEXT        NOT NULL,
  full_name    TEXT        NOT NULL,
  email        TEXT,
  phone        TEXT,
  total_donated NUMERIC(14,2) DEFAULT 0,
  last_donation TIMESTAMPTZ,
  cause_tags   TEXT        NOT NULL DEFAULT '[]', -- JSON
  status       TEXT        NOT NULL DEFAULT 'active',
  notes        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (id)
);

-- 12. Business/Startups: Investor tracker
CREATE TABLE IF NOT EXISTS business_investors (
  id            TEXT        NOT NULL DEFAULT gen_random_uuid()::text,
  user_id       TEXT        NOT NULL,
  investor_name TEXT        NOT NULL,
  firm          TEXT,
  email         TEXT,
  check_size    TEXT,        -- e.g. "$25k-$250k"
  focus_areas   TEXT,        -- e.g. "B2B SaaS, AI"
  stage         TEXT        NOT NULL DEFAULT 'contacted', -- 'identified' | 'contacted' | 'meeting' | 'term_sheet' | 'closed' | 'passed'
  notes         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (id)
);
