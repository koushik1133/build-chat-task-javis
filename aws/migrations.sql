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
-- ─────────────────────────────────────────────────────────────────────────────
-- Javis — Social Media Employee Module migration
-- Run via: node scripts/run-migrations.mjs  (after appending to migrations.sql)
-- DSQL: one DDL per transaction, no foreign keys, JSON stored as TEXT
-- ─────────────────────────────────────────────────────────────────────────────

-- ── social_brands: brand profile for social media generation ─────────────────
CREATE TABLE IF NOT EXISTS social_brands (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL,
  name          TEXT NOT NULL,
  website       TEXT,
  industry      TEXT,
  products      TEXT,
  tone          TEXT DEFAULT 'professional',
  brand_colors  TEXT,
  target_audience TEXT,
  posting_frequency TEXT DEFAULT 'daily',
  created_at    TIMESTAMP DEFAULT NOW(),
  updated_at    TIMESTAMP DEFAULT NOW()
);

CREATE INDEX ASYNC IF NOT EXISTS social_brands_user_id ON social_brands(user_id);

-- ── social_accounts: connected social platform accounts ──────────────────────
CREATE TABLE IF NOT EXISTS social_accounts (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL,
  brand_id      TEXT,
  platform      TEXT NOT NULL,
  handle        TEXT NOT NULL,
  display_name  TEXT,
  avatar_url    TEXT,
  connected     BOOLEAN DEFAULT TRUE,
  access_token  TEXT,
  refresh_token TEXT,
  expires_at    TIMESTAMP,
  created_at    TIMESTAMP DEFAULT NOW()
);

CREATE INDEX ASYNC IF NOT EXISTS social_accounts_user_id ON social_accounts(user_id);

-- ── social_posts: generated + scheduled + published posts ────────────────────
CREATE TABLE IF NOT EXISTS social_posts (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL,
  brand_id      TEXT,
  platform      TEXT NOT NULL,
  content_type  TEXT NOT NULL DEFAULT 'post',
  caption       TEXT NOT NULL,
  image_url     TEXT,
  image_prompt  TEXT,
  hashtags      TEXT,
  scheduled_at  TIMESTAMP,
  published_at  TIMESTAMP,
  status        TEXT NOT NULL DEFAULT 'draft',
  engagement    TEXT,
  notes         TEXT,
  created_at    TIMESTAMP DEFAULT NOW(),
  updated_at    TIMESTAMP DEFAULT NOW()
);

CREATE INDEX ASYNC IF NOT EXISTS social_posts_user_id ON social_posts(user_id);
CREATE INDEX ASYNC IF NOT EXISTS social_posts_status ON social_posts(status);
CREATE INDEX ASYNC IF NOT EXISTS social_posts_scheduled_at ON social_posts(scheduled_at);

-- ── social_ideas: AI-researched trend ideas and content bank ─────────────────
CREATE TABLE IF NOT EXISTS social_ideas (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL,
  brand_id      TEXT,
  title         TEXT NOT NULL,
  description   TEXT,
  platform      TEXT,
  content_type  TEXT,
  trend_score   INTEGER DEFAULT 0,
  used          BOOLEAN DEFAULT FALSE,
  created_at    TIMESTAMP DEFAULT NOW()
);

CREATE INDEX ASYNC IF NOT EXISTS social_ideas_user_id ON social_ideas(user_id);
-- ─────────────────────────────────────────────────────────────────────────────
-- Javis — Agency & Consultancy Operations Module Migration
-- Tables for managing client projects, employees, daily standups, AI proposals, and audits
-- ─────────────────────────────────────────────────────────────────────────────

-- ── agency_clients: client business profiles ────────────────────────────────
CREATE TABLE IF NOT EXISTS agency_clients (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL,
  company_name  TEXT NOT NULL,
  contact_person TEXT,
  email         TEXT,
  industry      TEXT,
  website       TEXT,
  total_spend   INTEGER DEFAULT 0,
  status        TEXT DEFAULT 'active',
  created_at    TIMESTAMP DEFAULT NOW(),
  updated_at    TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS agency_clients_user_id ON agency_clients(user_id);

-- ── agency_employees: consultancy developer & team roster ────────────────────
CREATE TABLE IF NOT EXISTS agency_employees (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL,
  name          TEXT NOT NULL,
  email         TEXT,
  role          TEXT NOT NULL,
  skills        TEXT,
  slack_handle  TEXT,
  active_projects INTEGER DEFAULT 0,
  created_at    TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS agency_employees_user_id ON agency_employees(user_id);

-- ── agency_projects: custom software & AI builds for clients ─────────────────
CREATE TABLE IF NOT EXISTS agency_projects (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL,
  client_id     TEXT,
  title         TEXT NOT NULL,
  project_type  TEXT NOT NULL, -- 'website', 'ai_agent', 'chatbot', 'automation', 'mobile_app'
  assigned_employee_id TEXT,
  assigned_employee_name TEXT,
  status        TEXT DEFAULT 'intake', -- 'intake', 'proposal', 'in_progress', 'in_review', 'delivered'
  progress_pct  INTEGER DEFAULT 0,
  budget        INTEGER DEFAULT 0,
  deadline      TIMESTAMP,
  deliverable_link TEXT,
  repo_url      TEXT,
  created_at    TIMESTAMP DEFAULT NOW(),
  updated_at    TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS agency_projects_user_id ON agency_projects(user_id);
CREATE INDEX IF NOT EXISTS agency_projects_status ON agency_projects(status);

-- ── agency_daily_standups: employee daily logs & AI risk analysis ─────────────
CREATE TABLE IF NOT EXISTS agency_daily_standups (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL,
  employee_id   TEXT NOT NULL,
  employee_name TEXT NOT NULL,
  project_id    TEXT,
  project_title TEXT,
  tasks_today   TEXT NOT NULL,
  plan_tomorrow TEXT,
  blockers      TEXT,
  risk_level    TEXT DEFAULT 'low', -- 'low', 'medium', 'high'
  ai_summary    TEXT,
  created_at    TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS agency_standups_user_id ON agency_daily_standups(user_id);
CREATE INDEX IF NOT EXISTS agency_standups_risk ON agency_daily_standups(risk_level);

-- ── agency_proposals: AI generated project proposals & technical specs ───────
CREATE TABLE IF NOT EXISTS agency_proposals (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL,
  client_name   TEXT NOT NULL,
  project_type  TEXT NOT NULL,
  raw_requirements TEXT NOT NULL,
  technical_spec TEXT,
  architecture  TEXT,
  milestones    TEXT, -- JSON string array
  cost_estimate INTEGER DEFAULT 0,
  estimated_days INTEGER DEFAULT 14,
  status        TEXT DEFAULT 'draft', -- 'draft', 'sent', 'approved', 'rejected'
  created_at    TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS agency_proposals_user_id ON agency_proposals(user_id);

-- ── agency_client_audits: AI Transformation & Tech Stack Audits ──────────────
CREATE TABLE IF NOT EXISTS agency_client_audits (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL,
  client_name   TEXT NOT NULL,
  industry      TEXT,
  current_tech  TEXT,
  ai_readiness_score INTEGER DEFAULT 50, -- 0 to 100
  recommended_agents TEXT, -- JSON array
  estimated_roi TEXT,
  audit_report  TEXT,
  created_at    TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS agency_client_audits_user_id ON agency_client_audits(user_id);

-- ═══════════════════════════════════════════════════════════════════════════
-- Domain expansion module (CRM, verticals, feature requests)
-- ═══════════════════════════════════════════════════════════════════════════

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

-- ═══════════════════════════════════════════════════════════════════════════
-- Feature expansions: agent swarms, lead enrichment, messaging, corrections
-- (previously stranded in supabase/migrations/005 — this is DSQL DDL)
-- ═══════════════════════════════════════════════════════════════════════════

-- ═══════════════════════════════════════════════════════════
-- Migration 005: Feature Expansions
-- Multi-Agent Swarms, Lead Outreach, WhatsApp/SMS, Self-Learning
-- Run each statement separately (DSQL: one DDL per transaction)
-- ═══════════════════════════════════════════════════════════

-- ─── Feature 1: Multi-Agent Swarm Builder ───────────────────

CREATE TABLE IF NOT EXISTS agent_swarms (
  id          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id     TEXT NOT NULL,
  name        TEXT NOT NULL,
  description TEXT,
  nodes       TEXT NOT NULL DEFAULT '[]',  -- JSON: [{agentId, order, customPrompt}]
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS agent_swarm_runs (
  id           TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  swarm_id     TEXT NOT NULL,              -- references agent_swarms.id (no FK in DSQL)
  user_id      TEXT NOT NULL,
  status       TEXT DEFAULT 'running',    -- running | complete | failed
  steps        TEXT DEFAULT '[]',          -- JSON: [{agentId, agentName, prompt, output, duration_ms, ts}]
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX ASYNC IF NOT EXISTS idx_agent_swarms_user ON agent_swarms (user_id);
CREATE INDEX ASYNC IF NOT EXISTS idx_agent_swarm_runs_user ON agent_swarm_runs (user_id);
CREATE INDEX ASYNC IF NOT EXISTS idx_agent_swarm_runs_swarm ON agent_swarm_runs (swarm_id);

-- ─── Feature 2: Lead Enrichment Columns ─────────────────────
-- Add enrichment columns to site_leads
-- (Run each ALTER separately)

ALTER TABLE site_leads ADD COLUMN IF NOT EXISTS user_id           TEXT;
ALTER TABLE site_leads ADD COLUMN IF NOT EXISTS research_summary  TEXT;
ALTER TABLE site_leads ADD COLUMN IF NOT EXISTS draft_email_subject TEXT;
ALTER TABLE site_leads ADD COLUMN IF NOT EXISTS draft_email_body  TEXT;
ALTER TABLE site_leads ADD COLUMN IF NOT EXISTS status            TEXT DEFAULT 'new';
ALTER TABLE site_leads ADD COLUMN IF NOT EXISTS sent_at           TIMESTAMPTZ;
ALTER TABLE site_leads ADD COLUMN IF NOT EXISTS enriched_at       TIMESTAMPTZ;
ALTER TABLE site_leads ADD COLUMN IF NOT EXISTS follow_up_at      TIMESTAMPTZ;

CREATE INDEX ASYNC IF NOT EXISTS idx_site_leads_user   ON site_leads (user_id);
CREATE INDEX ASYNC IF NOT EXISTS idx_site_leads_status ON site_leads (status);

-- ─── Feature 4: Messaging / WhatsApp / SMS ───────────────────

ALTER TABLE user_integrations ADD COLUMN IF NOT EXISTS whatsapp_provider    TEXT DEFAULT 'twilio_sandbox';
ALTER TABLE user_integrations ADD COLUMN IF NOT EXISTS whatsapp_phone_id    TEXT;
ALTER TABLE user_integrations ADD COLUMN IF NOT EXISTS whatsapp_access_token TEXT;
ALTER TABLE user_integrations ADD COLUMN IF NOT EXISTS twilio_sid            TEXT;
ALTER TABLE user_integrations ADD COLUMN IF NOT EXISTS twilio_auth_token     TEXT;
ALTER TABLE user_integrations ADD COLUMN IF NOT EXISTS twilio_from_number    TEXT;
ALTER TABLE user_integrations ADD COLUMN IF NOT EXISTS messaging_auto_reply  BOOLEAN DEFAULT false;

CREATE TABLE IF NOT EXISTS messaging_conversations (
  id          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id     TEXT NOT NULL,
  channel     TEXT NOT NULL,              -- 'whatsapp' | 'sms'
  from_number TEXT NOT NULL,
  messages    TEXT DEFAULT '[]',          -- JSON: [{role, content, ts}]
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX ASYNC IF NOT EXISTS idx_messaging_conv_user ON messaging_conversations (user_id);

-- ─── Feature 5: Self-Learning Corrections ───────────────────

CREATE TABLE IF NOT EXISTS agent_corrections (
  id             TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id        TEXT NOT NULL,
  agent_id       TEXT NOT NULL,           -- references agents.id (no FK in DSQL)
  original_text  TEXT NOT NULL,
  corrected_text TEXT NOT NULL,
  context        TEXT,                   -- optional: what kind of task was this for
  created_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX ASYNC IF NOT EXISTS idx_corrections_agent ON agent_corrections (agent_id);
CREATE INDEX ASYNC IF NOT EXISTS idx_corrections_user  ON agent_corrections (user_id);

-- ── agent_swarm_runs: columns the swarm runner writes ────────────────────────
ALTER TABLE agent_swarm_runs ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ;
ALTER TABLE agent_swarm_runs ADD COLUMN IF NOT EXISTS final_output TEXT;

-- ═══════════════════════════════════════════════════════════════════════════
-- Ads module — Meta Ads + Google Ads unified reporting
-- ═══════════════════════════════════════════════════════════════════════════

-- Tokens are stored encrypted (AES-256-GCM) via src/lib/secure-store.ts.
CREATE TABLE IF NOT EXISTS ad_accounts (
  id                  TEXT PRIMARY KEY,
  user_id             TEXT NOT NULL,
  platform            TEXT NOT NULL,           -- 'meta_ads' | 'google_ads'
  account_id          TEXT NOT NULL,
  account_name        TEXT,
  access_token_enc    TEXT,
  developer_token_enc TEXT,
  login_customer_id   TEXT,
  connected           BOOLEAN DEFAULT TRUE,
  last_synced_at      TIMESTAMPTZ,
  last_sync_error     TEXT,
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX ASYNC IF NOT EXISTS idx_ad_accounts_user ON ad_accounts (user_id);

-- stat_key = <account_id>:<ad_id>:<date> keeps re-syncs idempotent.
CREATE TABLE IF NOT EXISTS ad_stats (
  id               TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL,
  ad_account_id    TEXT NOT NULL,
  stat_key         TEXT NOT NULL,
  platform         TEXT NOT NULL,
  campaign_id      TEXT,
  campaign_name    TEXT,
  ad_set_id        TEXT,
  ad_id            TEXT,
  ad_name          TEXT,
  stat_date        DATE NOT NULL,
  impressions      BIGINT DEFAULT 0,
  reach            BIGINT DEFAULT 0,
  frequency        DOUBLE PRECISION DEFAULT 0,
  clicks           BIGINT DEFAULT 0,
  spend            DOUBLE PRECISION DEFAULT 0,
  conversions      DOUBLE PRECISION DEFAULT 0,
  conversion_value DOUBLE PRECISION DEFAULT 0,
  video_plays      BIGINT DEFAULT 0,
  thru_plays       BIGINT DEFAULT 0,
  created_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX ASYNC IF NOT EXISTS idx_ad_stats_key ON ad_stats (user_id, stat_key);
CREATE INDEX ASYNC IF NOT EXISTS idx_ad_stats_user_date ON ad_stats (user_id, stat_date);

-- ── domain_feature_request_votes: one upvote per user per request ────────────
CREATE TABLE IF NOT EXISTS domain_feature_request_votes (
  id         TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX ASYNC IF NOT EXISTS idx_feature_votes_unique
  ON domain_feature_request_votes (request_id, user_id);

-- ── social publishing: per-user upload-post profile + platform post ids ──────
ALTER TABLE user_integrations ADD COLUMN IF NOT EXISTS upload_post_profile TEXT;
ALTER TABLE social_posts ADD COLUMN IF NOT EXISTS platform_post_id TEXT;
ALTER TABLE social_posts ADD COLUMN IF NOT EXISTS publish_error TEXT;

-- ── channel nav + per-channel pages: both queries filter (user_id, platform) ──
CREATE INDEX ASYNC IF NOT EXISTS idx_social_accounts_user_platform
  ON social_accounts (user_id, platform);
CREATE INDEX ASYNC IF NOT EXISTS idx_social_posts_user_platform
  ON social_posts (user_id, platform);

-- ── schema_migrations: lets the runner skip statements it already applied ────
CREATE TABLE IF NOT EXISTS schema_migrations (
  hash       TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ DEFAULT NOW()
);

-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 1 — autonomous agent runtime
-- ═══════════════════════════════════════════════════════════════════════════

-- ── agents: runtime configuration ────────────────────────────────────────────
ALTER TABLE agents ADD COLUMN IF NOT EXISTS tools TEXT;              -- JSON array of tool names (NULL = all)
ALTER TABLE agents ADD COLUMN IF NOT EXISTS model TEXT;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS autonomy_level TEXT;     -- draft | approve | auto
ALTER TABLE agents ADD COLUMN IF NOT EXISTS max_steps INTEGER;
UPDATE agents SET autonomy_level = 'approve' WHERE autonomy_level IS NULL;

-- ── agent_runs: lifecycle + cost ─────────────────────────────────────────────
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS status TEXT;         -- queued|running|awaiting_approval|done|failed|cancelled
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS trigger_kind TEXT;
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS trigger_ref TEXT;
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS error TEXT;
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS tokens_in INTEGER;
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS tokens_out INTEGER;
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS cost_micros BIGINT;
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ;
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS finished_at TIMESTAMPTZ;
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS attempt INTEGER;
UPDATE agent_runs SET status = 'done' WHERE status IS NULL;
CREATE INDEX ASYNC IF NOT EXISTS idx_agent_runs_user_status ON agent_runs (user_id, status);

-- ── agent_run_steps: every LLM turn, tool call and approval, in order ────────
CREATE TABLE IF NOT EXISTS agent_run_steps (
  id         TEXT PRIMARY KEY,
  run_id     TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  idx        INTEGER NOT NULL,
  kind       TEXT NOT NULL,          -- llm | tool | approval | note
  name       TEXT,
  input      TEXT,
  output     TEXT,
  tokens     INTEGER,
  ms         INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX ASYNC IF NOT EXISTS idx_agent_run_steps_run ON agent_run_steps (run_id, idx);

-- ── agent_jobs: durable work queue (claim-by-UPDATE, lease reclaim, DLQ) ─────
CREATE TABLE IF NOT EXISTS agent_jobs (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  kind         TEXT NOT NULL,        -- run | resume | playbook | outbox
  payload      TEXT NOT NULL,
  status       TEXT NOT NULL,        -- queued | running | done | failed | dead
  attempts     INTEGER DEFAULT 0,
  max_attempts INTEGER DEFAULT 3,
  run_after    TIMESTAMPTZ NOT NULL,
  locked_at    TIMESTAMPTZ,
  locked_by    TEXT,
  last_error   TEXT,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX ASYNC IF NOT EXISTS idx_agent_jobs_due ON agent_jobs (status, run_after);
CREATE INDEX ASYNC IF NOT EXISTS idx_agent_jobs_user ON agent_jobs (user_id, created_at);

-- ── agent_triggers: schedule / event / webhook / inbound ─────────────────────
CREATE TABLE IF NOT EXISTS agent_triggers (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  agent_id     TEXT NOT NULL,
  kind         TEXT NOT NULL,        -- schedule | event | webhook | inbound
  cron_expr    TEXT,
  timezone     TEXT,
  event_type   TEXT,
  secret_hash  TEXT,                 -- webhook token, hashed
  config       TEXT,                 -- JSON: prompt override, filters
  enabled      BOOLEAN DEFAULT TRUE,
  next_run_at  TIMESTAMPTZ,
  last_run_at  TIMESTAMPTZ,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX ASYNC IF NOT EXISTS idx_agent_triggers_user ON agent_triggers (user_id);
CREATE INDEX ASYNC IF NOT EXISTS idx_agent_triggers_due ON agent_triggers (kind, enabled, next_run_at);
CREATE INDEX ASYNC IF NOT EXISTS idx_agent_triggers_event ON agent_triggers (user_id, event_type);

-- ── events: append-only business event log ───────────────────────────────────
CREATE TABLE IF NOT EXISTS events (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  type       TEXT NOT NULL,
  entity     TEXT NOT NULL,
  entity_id  TEXT NOT NULL,
  data       TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX ASYNC IF NOT EXISTS idx_events_user_type ON events (user_id, type, created_at);

-- ── approvals: human-in-the-loop inbox for gated tool calls ──────────────────
CREATE TABLE IF NOT EXISTS approvals (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  run_id     TEXT,
  agent_id   TEXT,
  tool_name  TEXT NOT NULL,
  input      TEXT,
  preview    TEXT,
  status     TEXT NOT NULL,          -- pending | approved | rejected | expired
  decided_by TEXT,
  decided_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX ASYNC IF NOT EXISTS idx_approvals_user_status ON approvals (user_id, status, created_at);

-- ── ai_usage / ai_budgets: metering, caps and model governance ───────────────
CREATE TABLE IF NOT EXISTS ai_usage (
  id                TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL,
  run_id            TEXT,
  feature           TEXT NOT NULL,   -- agent | copilot | chat | playbook | receptionist | generate
  provider          TEXT NOT NULL,
  model             TEXT NOT NULL,
  prompt_tokens     INTEGER DEFAULT 0,
  completion_tokens INTEGER DEFAULT 0,
  cost_micros       BIGINT DEFAULT 0,
  created_at        TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX ASYNC IF NOT EXISTS idx_ai_usage_user_time ON ai_usage (user_id, created_at);

CREATE TABLE IF NOT EXISTS ai_budgets (
  user_id           TEXT PRIMARY KEY,
  monthly_cap_micros BIGINT,
  hard_stop         BOOLEAN DEFAULT TRUE,
  model_allowlist   TEXT,             -- JSON array of provider ids / model names
  updated_at        TIMESTAMPTZ DEFAULT NOW()
);

-- ── playbook_runs: dedupe / cooldown for proactive workflows ─────────────────
CREATE TABLE IF NOT EXISTS playbook_runs (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  playbook_id TEXT NOT NULL,
  entity_id   TEXT,
  run_id      TEXT,
  status      TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX ASYNC IF NOT EXISTS idx_playbook_runs_key ON playbook_runs (user_id, playbook_id, entity_id, created_at);

-- ── api_keys: MCP / public API access ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS api_keys (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  name         TEXT NOT NULL,
  key_hash     TEXT NOT NULL,
  key_prefix   TEXT NOT NULL,        -- first 8 chars, for display
  scopes       TEXT,                 -- JSON array
  last_used_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  revoked_at   TIMESTAMPTZ
);
CREATE INDEX ASYNC IF NOT EXISTS idx_api_keys_hash ON api_keys (key_hash);
CREATE INDEX ASYNC IF NOT EXISTS idx_api_keys_user ON api_keys (user_id);

-- ── playbook_settings: per-user enable/disable of proactive playbooks ────────
CREATE TABLE IF NOT EXISTS playbook_settings (
  user_id     TEXT NOT NULL,
  playbook_id TEXT NOT NULL,
  enabled     BOOLEAN DEFAULT TRUE,
  updated_at  TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (user_id, playbook_id)
);

-- ═══════════════════════════════════════════════════════════════════════════
-- PHASE 2 — organizations, roles, audit, outbox, money, portal, booking
-- Scoping model: every organization has an owner_user_id. Existing tables stay
-- keyed by user_id; a member of an org reads/writes rows where
-- user_id = organizations.owner_user_id (see src/lib/auth/scope.ts).
-- ═══════════════════════════════════════════════════════════════════════════

-- ── organizations ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS organizations (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  slug           TEXT NOT NULL,
  owner_user_id  TEXT NOT NULL,
  settings       TEXT,                -- JSON: branding, currency, locale, timezone
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  updated_at     TIMESTAMPTZ DEFAULT NOW()
);
CREATE UNIQUE INDEX ASYNC IF NOT EXISTS idx_organizations_slug ON organizations (slug);
CREATE UNIQUE INDEX ASYNC IF NOT EXISTS idx_organizations_owner ON organizations (owner_user_id);

-- ── memberships: users ↔ organizations with a role ───────────────────────────
CREATE TABLE IF NOT EXISTS memberships (
  id                TEXT PRIMARY KEY,
  org_id            TEXT NOT NULL,
  user_id           TEXT,                       -- NULL until an invite is accepted
  role              TEXT NOT NULL DEFAULT 'member',  -- owner|admin|manager|member|viewer
  status            TEXT NOT NULL DEFAULT 'active',  -- active|invited|removed
  invited_email     TEXT,
  invite_token_hash TEXT,
  invited_by        TEXT,
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  accepted_at       TIMESTAMPTZ,
  updated_at        TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX ASYNC IF NOT EXISTS idx_memberships_org ON memberships (org_id, status);
CREATE INDEX ASYNC IF NOT EXISTS idx_memberships_user ON memberships (user_id, status);
CREATE INDEX ASYNC IF NOT EXISTS idx_memberships_invite ON memberships (invite_token_hash);

-- ── role_area_overrides: per-org customisation of the role × area matrix ─────
CREATE TABLE IF NOT EXISTS role_area_overrides (
  org_id     TEXT NOT NULL,
  role       TEXT NOT NULL,
  area       TEXT NOT NULL,
  can_view   BOOLEAN DEFAULT TRUE,
  can_edit   BOOLEAN DEFAULT FALSE,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (org_id, role, area)
);

-- ==== PHASE 2 LANE B: audit + soft delete + outbox ====

-- ── audit_log: who changed what (diff is JSON {field: [old, new]}) ──────────
CREATE TABLE IF NOT EXISTS audit_log (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,            -- org data id (organizations.owner_user_id)
  actor_id    TEXT,
  actor_email TEXT,
  action      TEXT NOT NULL,            -- create|update|delete|restore|…
  entity      TEXT NOT NULL,
  entity_id   TEXT,
  diff        TEXT,                     -- JSON {field: [old, new]}
  ip          TEXT,
  user_agent  TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX ASYNC IF NOT EXISTS idx_audit_log_user_created ON audit_log (user_id, created_at);
CREATE INDEX ASYNC IF NOT EXISTS idx_audit_log_user_entity ON audit_log (user_id, entity, entity_id);

-- ── soft delete: deleted_at on the main entity tables ───────────────────────
ALTER TABLE crm_contacts ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE production_tasks ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE sites ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

-- ── notification_outbox: every outbound message, live or simulated ──────────
CREATE TABLE IF NOT EXISTS notification_outbox (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,           -- org data id
  channel      TEXT NOT NULL,           -- email|sms|whatsapp|in_app|webhook
  recipient    TEXT NOT NULL,
  subject      TEXT,
  body         TEXT,
  data         TEXT,                    -- JSON
  status       TEXT NOT NULL DEFAULT 'queued',  -- queued|sent|simulated|failed|read
  attempts     INTEGER DEFAULT 0,
  error        TEXT,
  scheduled_at TIMESTAMPTZ DEFAULT NOW(),
  sent_at      TIMESTAMPTZ,
  read_at      TIMESTAMPTZ,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX ASYNC IF NOT EXISTS idx_notification_outbox_due ON notification_outbox (status, scheduled_at);
CREATE INDEX ASYNC IF NOT EXISTS idx_notification_outbox_user ON notification_outbox (user_id, channel, status);

-- ==== PHASE 2 LANE C: payments, quotes, invoices ====

-- ── quotes ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS quotes (
  id               TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL,            -- org data id
  contact_id       TEXT,
  number           TEXT NOT NULL,            -- Q-000001
  status           TEXT NOT NULL DEFAULT 'draft', -- draft|sent|viewed|accepted|declined|expired
  currency         TEXT NOT NULL DEFAULT 'USD',
  subtotal_minor   BIGINT NOT NULL DEFAULT 0,
  tax_minor        BIGINT NOT NULL DEFAULT 0,
  total_minor      BIGINT NOT NULL DEFAULT 0,
  valid_until      TIMESTAMPTZ,
  terms_version    TEXT,
  terms_text       TEXT,
  notes            TEXT,
  current_version  INTEGER NOT NULL DEFAULT 1,
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  updated_at       TIMESTAMPTZ DEFAULT NOW(),
  sent_at          TIMESTAMPTZ,
  accepted_at      TIMESTAMPTZ
);
CREATE INDEX ASYNC IF NOT EXISTS idx_quotes_user_created ON quotes (user_id, created_at);
CREATE INDEX ASYNC IF NOT EXISTS idx_quotes_user_contact ON quotes (user_id, contact_id);

-- ── quote_versions: append-only line-item snapshots ─────────────────────────
CREATE TABLE IF NOT EXISTS quote_versions (
  id              TEXT PRIMARY KEY,
  quote_id        TEXT NOT NULL,
  version         INTEGER NOT NULL,
  items           TEXT NOT NULL DEFAULT '[]', -- JSON [{description, qty, unit_minor, tax_rate_bp}]
  subtotal_minor  BIGINT NOT NULL DEFAULT 0,
  tax_minor       BIGINT NOT NULL DEFAULT 0,
  total_minor     BIGINT NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX ASYNC IF NOT EXISTS idx_quote_versions_quote ON quote_versions (quote_id, version);

-- ── quote_acceptances: OTP + consent snapshot ───────────────────────────────
CREATE TABLE IF NOT EXISTS quote_acceptances (
  id                     TEXT PRIMARY KEY,
  quote_id               TEXT NOT NULL,
  version                INTEGER NOT NULL,
  otp_hash               TEXT,
  otp_expires_at         TIMESTAMPTZ,
  otp_attempts           INTEGER NOT NULL DEFAULT 0,
  accepted_at            TIMESTAMPTZ,
  accepted_name          TEXT,
  accepted_email         TEXT,
  consent_terms_version  TEXT,
  consent_terms_text     TEXT,
  ip                     TEXT,
  user_agent             TEXT,
  created_at             TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX ASYNC IF NOT EXISTS idx_quote_acceptances_quote ON quote_acceptances (quote_id, created_at);

-- ── invoices ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS invoices (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL,
  contact_id      TEXT,
  quote_id        TEXT,
  number          TEXT NOT NULL,             -- INV-000001
  status          TEXT NOT NULL DEFAULT 'draft', -- draft|sent|partially_paid|paid|void|overdue
  currency        TEXT NOT NULL DEFAULT 'USD',
  subtotal_minor  BIGINT NOT NULL DEFAULT 0,
  tax_minor       BIGINT NOT NULL DEFAULT 0,
  total_minor     BIGINT NOT NULL DEFAULT 0,
  paid_minor      BIGINT NOT NULL DEFAULT 0,
  due_at          TIMESTAMPTZ,
  items           TEXT NOT NULL DEFAULT '[]', -- JSON
  notes           TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  sent_at         TIMESTAMPTZ,
  paid_at         TIMESTAMPTZ
);
CREATE INDEX ASYNC IF NOT EXISTS idx_invoices_user_created ON invoices (user_id, created_at);
CREATE INDEX ASYNC IF NOT EXISTS idx_invoices_user_status ON invoices (user_id, status);
CREATE INDEX ASYNC IF NOT EXISTS idx_invoices_quote ON invoices (quote_id);

-- ── invoice_payments ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS invoice_payments (
  id            TEXT PRIMARY KEY,
  invoice_id    TEXT NOT NULL,
  provider      TEXT NOT NULL,
  provider_ref  TEXT,
  amount_minor  BIGINT NOT NULL,
  currency      TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'succeeded', -- succeeded|failed
  created_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX ASYNC IF NOT EXISTS idx_invoice_payments_invoice ON invoice_payments (invoice_id, created_at);

-- ── payment_events: webhook idempotency ledger ──────────────────────────────
CREATE TABLE IF NOT EXISTS payment_events (
  id                 TEXT PRIMARY KEY,
  provider           TEXT NOT NULL,
  provider_event_id  TEXT NOT NULL,
  payload            TEXT,
  processed_at       TIMESTAMPTZ DEFAULT NOW()
);
CREATE UNIQUE INDEX ASYNC IF NOT EXISTS idx_payment_events_provider_event ON payment_events (provider, provider_event_id);

-- ── doc_counters: per-org document numbering ────────────────────────────────
CREATE TABLE IF NOT EXISTS doc_counters (
  user_id     TEXT NOT NULL,
  kind        TEXT NOT NULL,      -- quote|invoice
  next_value  INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (user_id, kind)
);

-- ── share_tokens: public links for quotes / invoices / pay pages ────────────
CREATE TABLE IF NOT EXISTS share_tokens (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL,
  kind            TEXT NOT NULL,       -- quote|invoice|pay|portal
  entity_id       TEXT NOT NULL,
  token_hash      TEXT NOT NULL,       -- sha256(token)
  expires_at      TIMESTAMPTZ,
  revoked_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  last_viewed_at  TIMESTAMPTZ
);
CREATE UNIQUE INDEX ASYNC IF NOT EXISTS idx_share_tokens_hash ON share_tokens (token_hash);
CREATE INDEX ASYNC IF NOT EXISTS idx_share_tokens_entity ON share_tokens (kind, entity_id);


-- ==== PHASE 2 LANE D: calendar, booking, client portal ====

-- ── calendars: one or more per org; rules are in the calendar's timezone ────
CREATE TABLE IF NOT EXISTS calendars (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,                 -- org data id
  name       TEXT NOT NULL,
  timezone   TEXT NOT NULL DEFAULT 'UTC',
  color      TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX ASYNC IF NOT EXISTS idx_calendars_user ON calendars (user_id);

-- ── availability_rules: weekly recurring windows (minutes from local midnight)
CREATE TABLE IF NOT EXISTS availability_rules (
  id           TEXT PRIMARY KEY,
  calendar_id  TEXT NOT NULL,
  weekday      INTEGER NOT NULL,            -- 0=Sunday … 6=Saturday
  start_minute INTEGER NOT NULL,
  end_minute   INTEGER NOT NULL,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX ASYNC IF NOT EXISTS idx_availability_rules_calendar ON availability_rules (calendar_id, weekday);

-- ── booking_types: public bookable services ─────────────────────────────────
CREATE TABLE IF NOT EXISTS booking_types (
  id                 TEXT PRIMARY KEY,
  user_id            TEXT NOT NULL,
  calendar_id        TEXT NOT NULL,
  slug               TEXT NOT NULL,
  name               TEXT NOT NULL,
  description        TEXT,
  duration_minutes   INTEGER NOT NULL DEFAULT 30,
  buffer_before      INTEGER NOT NULL DEFAULT 0,
  buffer_after       INTEGER NOT NULL DEFAULT 0,
  min_notice_minutes INTEGER NOT NULL DEFAULT 60,
  max_days_ahead     INTEGER NOT NULL DEFAULT 30,
  price_minor        INTEGER,
  currency           TEXT,
  active             BOOLEAN NOT NULL DEFAULT TRUE,
  created_at         TIMESTAMPTZ DEFAULT NOW()
);
CREATE UNIQUE INDEX ASYNC IF NOT EXISTS idx_booking_types_user_slug ON booking_types (user_id, slug);
CREATE INDEX ASYNC IF NOT EXISTS idx_booking_types_calendar ON booking_types (calendar_id);

-- ── bookings ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bookings (
  id                TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL,
  calendar_id       TEXT NOT NULL,
  booking_type_id   TEXT,
  contact_id        TEXT,
  name              TEXT NOT NULL,
  email             TEXT,
  phone             TEXT,
  starts_at         TIMESTAMPTZ NOT NULL,
  ends_at           TIMESTAMPTZ NOT NULL,
  status            TEXT NOT NULL DEFAULT 'confirmed',  -- confirmed|cancelled|completed|no_show
  notes             TEXT,
  source            TEXT NOT NULL DEFAULT 'manual',     -- manual|public|agent|portal
  cancel_token_hash TEXT,
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX ASYNC IF NOT EXISTS idx_bookings_calendar_starts ON bookings (calendar_id, starts_at);
CREATE INDEX ASYNC IF NOT EXISTS idx_bookings_user_starts ON bookings (user_id, starts_at);
CREATE INDEX ASYNC IF NOT EXISTS idx_bookings_contact ON bookings (contact_id);
CREATE INDEX ASYNC IF NOT EXISTS idx_bookings_cancel_token ON bookings (cancel_token_hash);

-- ── calendar_blocks: ad-hoc unavailability ──────────────────────────────────
CREATE TABLE IF NOT EXISTS calendar_blocks (
  id          TEXT PRIMARY KEY,
  calendar_id TEXT NOT NULL,
  starts_at   TIMESTAMPTZ NOT NULL,
  ends_at     TIMESTAMPTZ NOT NULL,
  reason      TEXT
);
CREATE INDEX ASYNC IF NOT EXISTS idx_calendar_blocks_calendar_starts ON calendar_blocks (calendar_id, starts_at);

-- ==== PHASE 2 LANE E: security ====
-- Per-site CORS allow-list for the public lead/widget endpoints.
-- JSON array or comma-separated origins, e.g. '["https://acme.com"]'. NULL = use PUBLIC_WIDGET_ORIGINS env.
ALTER TABLE sites ADD COLUMN IF NOT EXISTS allowed_origins TEXT;

-- ==== PHASE 3 LANE A ====
-- Phase 3 / Lane A: configurable records + workflow primitive
CREATE TABLE IF NOT EXISTS record_types (
  id             TEXT        NOT NULL DEFAULT gen_random_uuid()::text,
  user_id        TEXT        NOT NULL,
  slug           TEXT        NOT NULL,
  name           TEXT        NOT NULL,
  icon           TEXT,
  description    TEXT,
  fields         TEXT        NOT NULL DEFAULT '[]', -- JSON array of field defs
  stages         TEXT        NOT NULL DEFAULT '[]', -- JSON array of {key,label,color}
  views          TEXT        NOT NULL DEFAULT '{}', -- JSON
  copilot_prompt TEXT,
  pack_slug      TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (id)
);

CREATE UNIQUE INDEX ASYNC IF NOT EXISTS record_types_user_slug ON record_types(user_id, slug);

CREATE TABLE IF NOT EXISTS records (
  id           TEXT        NOT NULL DEFAULT gen_random_uuid()::text,
  user_id      TEXT        NOT NULL,
  type_id      TEXT        NOT NULL,
  title        TEXT        NOT NULL,
  stage        TEXT        NOT NULL,
  data         TEXT        NOT NULL DEFAULT '{}', -- JSON object keyed by field key
  summary      TEXT,
  contact_id   TEXT,
  amount_minor BIGINT,
  currency     TEXT,
  due_at       TIMESTAMPTZ,
  assigned_to  TEXT,
  deleted_at   TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (id)
);

CREATE INDEX ASYNC IF NOT EXISTS records_user_type_stage ON records(user_id, type_id, stage);

CREATE INDEX ASYNC IF NOT EXISTS records_user_type_updated ON records(user_id, type_id, updated_at);

CREATE TABLE IF NOT EXISTS record_activity (
  id         TEXT        NOT NULL DEFAULT gen_random_uuid()::text,
  user_id    TEXT        NOT NULL,
  record_id  TEXT        NOT NULL,
  actor_id   TEXT,
  kind       TEXT        NOT NULL DEFAULT 'comment', -- created|moved|updated|comment|linked
  body       TEXT,
  diff       TEXT, -- JSON
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (id)
);

CREATE INDEX ASYNC IF NOT EXISTS record_activity_record ON record_activity(user_id, record_id, created_at);

CREATE TABLE IF NOT EXISTS record_links (
  id          TEXT        NOT NULL DEFAULT gen_random_uuid()::text,
  user_id     TEXT        NOT NULL,
  record_id   TEXT        NOT NULL,
  target_kind TEXT        NOT NULL, -- contact|task|quote|invoice|booking|record
  target_id   TEXT        NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (id)
);

CREATE INDEX ASYNC IF NOT EXISTS record_links_record ON record_links(user_id, record_id);


-- ==== PHASE 3 LANE B ====
-- ── Phase 3 / Lane B: Helpdesk (tickets + SLAs) and Knowledge base ───────────

CREATE TABLE IF NOT EXISTS sla_policies (
  id                      TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id                 TEXT NOT NULL,
  name                    TEXT NOT NULL,
  first_response_minutes  INTEGER NOT NULL DEFAULT 60,
  resolution_minutes      INTEGER NOT NULL DEFAULT 1440,
  business_hours_only     BOOLEAN NOT NULL DEFAULT FALSE,
  priority_overrides      TEXT,                -- JSON: { "urgent": { "first_response_minutes": 15, "resolution_minutes": 240 } }
  is_default              BOOLEAN NOT NULL DEFAULT FALSE,
  created_at              TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX ASYNC IF NOT EXISTS idx_sla_policies_user ON sla_policies (user_id);

CREATE TABLE IF NOT EXISTS tickets (
  id                       TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id                  TEXT NOT NULL,
  number                   INTEGER NOT NULL,
  subject                  TEXT NOT NULL,
  status                   TEXT NOT NULL DEFAULT 'open',      -- open|pending|resolved|closed
  priority                 TEXT NOT NULL DEFAULT 'normal',    -- low|normal|high|urgent
  source                   TEXT NOT NULL DEFAULT 'manual',    -- portal|widget|email|sms|whatsapp|manual|agent
  contact_id               TEXT,
  requester_email          TEXT,
  requester_name           TEXT,
  assigned_to              TEXT,
  sla_policy_id            TEXT,
  first_response_due_at    TIMESTAMPTZ,
  resolution_due_at        TIMESTAMPTZ,
  first_responded_at       TIMESTAMPTZ,
  resolved_at              TIMESTAMPTZ,
  breached_first_response  BOOLEAN NOT NULL DEFAULT FALSE,
  breached_resolution      BOOLEAN NOT NULL DEFAULT FALSE,
  escalated_at             TIMESTAMPTZ,
  tags                     TEXT NOT NULL DEFAULT '[]',        -- JSON array
  conversation_id          TEXT,
  created_at               TIMESTAMPTZ DEFAULT NOW(),
  updated_at               TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX ASYNC IF NOT EXISTS idx_tickets_user_status ON tickets (user_id, status);
CREATE INDEX ASYNC IF NOT EXISTS idx_tickets_user_resolution_due ON tickets (user_id, resolution_due_at);
CREATE INDEX ASYNC IF NOT EXISTS idx_tickets_user_contact ON tickets (user_id, contact_id);

CREATE TABLE IF NOT EXISTS ticket_messages (
  id           TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id      TEXT NOT NULL,
  ticket_id    TEXT NOT NULL,
  author_kind  TEXT NOT NULL,                    -- agent|customer|ai|system
  author_id    TEXT,
  body         TEXT NOT NULL,
  is_internal  BOOLEAN NOT NULL DEFAULT FALSE,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX ASYNC IF NOT EXISTS idx_ticket_messages_ticket ON ticket_messages (ticket_id, created_at);

CREATE TABLE IF NOT EXISTS ticket_counters (
  user_id      TEXT PRIMARY KEY,
  next_number  INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS kb_articles (
  id                 TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id            TEXT NOT NULL,
  slug               TEXT NOT NULL,
  title              TEXT NOT NULL,
  body_md            TEXT NOT NULL DEFAULT '',
  excerpt            TEXT,
  category           TEXT,
  tags               TEXT NOT NULL DEFAULT '[]',   -- JSON array
  status             TEXT NOT NULL DEFAULT 'draft', -- draft|published
  is_public          BOOLEAN NOT NULL DEFAULT FALSE,
  views              INTEGER NOT NULL DEFAULT 0,
  source_ticket_ids  TEXT NOT NULL DEFAULT '[]',   -- JSON array
  created_at         TIMESTAMPTZ DEFAULT NOW(),
  updated_at         TIMESTAMPTZ DEFAULT NOW(),
  published_at       TIMESTAMPTZ
);
CREATE UNIQUE INDEX ASYNC IF NOT EXISTS idx_kb_articles_user_slug ON kb_articles (user_id, slug);
CREATE INDEX ASYNC IF NOT EXISTS idx_kb_articles_user_status ON kb_articles (user_id, status);

CREATE TABLE IF NOT EXISTS kb_categories (
  id       TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id  TEXT NOT NULL,
  slug     TEXT NOT NULL,
  name     TEXT NOT NULL,
  sort     INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX ASYNC IF NOT EXISTS idx_kb_categories_user_slug ON kb_categories (user_id, slug);

-- Ticket numbers are unique per org; public help center lists only published+public rows.
CREATE UNIQUE INDEX ASYNC IF NOT EXISTS idx_tickets_user_number ON tickets (user_id, number);
CREATE INDEX ASYNC IF NOT EXISTS idx_tickets_user_first_response_due ON tickets (user_id, first_response_due_at);
CREATE INDEX ASYNC IF NOT EXISTS idx_kb_articles_user_public ON kb_articles (user_id, is_public, status);
CREATE INDEX ASYNC IF NOT EXISTS idx_kb_categories_user_sort ON kb_categories (user_id, sort);


-- ==== PHASE 3 LANE C ====
-- ==== PHASE 3 LANE C: inventory / pricebook, expenses, time, change orders ====
-- DSQL rules: no FKs, JSON stored as TEXT, CREATE INDEX ASYNC, one DDL per statement.
-- All tables are keyed by user_id = organizations.owner_user_id (requireScope().dataId).

-- ── products: pricebook + stock ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS products (
  id               TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL,
  sku              TEXT,
  name             TEXT NOT NULL,
  description      TEXT,
  kind             TEXT NOT NULL DEFAULT 'product',   -- product|service|rental
  unit             TEXT NOT NULL DEFAULT 'each',
  unit_price_minor BIGINT NOT NULL DEFAULT 0,
  cost_minor       BIGINT NOT NULL DEFAULT 0,
  currency         TEXT NOT NULL DEFAULT 'USD',
  tax_rate_bp      INTEGER NOT NULL DEFAULT 0,
  track_stock      BOOLEAN NOT NULL DEFAULT FALSE,
  stock_on_hand    INTEGER NOT NULL DEFAULT 0,
  stock_reserved   INTEGER NOT NULL DEFAULT 0,
  reorder_point    INTEGER NOT NULL DEFAULT 0,
  active           BOOLEAN NOT NULL DEFAULT TRUE,
  deleted_at       TIMESTAMPTZ,
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  updated_at       TIMESTAMPTZ DEFAULT NOW()
);
CREATE UNIQUE INDEX ASYNC IF NOT EXISTS idx_products_user_sku ON products (user_id, sku);
CREATE INDEX ASYNC IF NOT EXISTS idx_products_user_name ON products (user_id, name);
CREATE INDEX ASYNC IF NOT EXISTS idx_products_user_kind ON products (user_id, kind);

-- ── stock_movements: append-only ledger ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS stock_movements (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  product_id  TEXT NOT NULL,
  kind        TEXT NOT NULL,            -- receive|reserve|release|consume|adjust|checkout|checkin
  qty         INTEGER NOT NULL,         -- signed for adjust; positive otherwise
  ref_kind    TEXT,                     -- quote|invoice|booking|record|checkout|manual
  ref_id      TEXT,
  note        TEXT,
  created_by  TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX ASYNC IF NOT EXISTS idx_stock_movements_product ON stock_movements (user_id, product_id, created_at);
CREATE INDEX ASYNC IF NOT EXISTS idx_stock_movements_ref ON stock_movements (user_id, ref_kind, ref_id);

-- ── equipment_checkouts: rentals / kit out on a job ─────────────────────────
CREATE TABLE IF NOT EXISTS equipment_checkouts (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL,
  product_id      TEXT NOT NULL,
  qty             INTEGER NOT NULL DEFAULT 1,
  checked_out_to  TEXT,                 -- member id, contact name, or free text
  ref_kind        TEXT,
  ref_id          TEXT,
  due_back_at     TIMESTAMPTZ,
  returned_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX ASYNC IF NOT EXISTS idx_equipment_checkouts_user ON equipment_checkouts (user_id, returned_at, due_back_at);
CREATE INDEX ASYNC IF NOT EXISTS idx_equipment_checkouts_product ON equipment_checkouts (user_id, product_id);

-- ── expenses ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS expenses (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL,
  category      TEXT NOT NULL DEFAULT 'general',
  vendor        TEXT,
  description   TEXT,
  amount_minor  BIGINT NOT NULL DEFAULT 0,
  currency      TEXT NOT NULL DEFAULT 'USD',
  tax_minor     BIGINT NOT NULL DEFAULT 0,
  spent_at      TIMESTAMPTZ DEFAULT NOW(),
  receipt_url   TEXT,
  ref_kind      TEXT,                   -- quote|invoice|booking|record|...
  ref_id        TEXT,
  billable      BOOLEAN NOT NULL DEFAULT FALSE,
  invoice_id    TEXT,                   -- set once billed through /api/invoices/[id]/billables
  created_by    TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX ASYNC IF NOT EXISTS idx_expenses_user_spent ON expenses (user_id, spent_at);
CREATE INDEX ASYNC IF NOT EXISTS idx_expenses_user_ref ON expenses (user_id, ref_kind, ref_id);
CREATE INDEX ASYNC IF NOT EXISTS idx_expenses_invoice ON expenses (invoice_id);

-- ── time_entries ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS time_entries (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  member_id    TEXT,                    -- actor user id (memberships.user_id)
  ref_kind     TEXT,
  ref_id       TEXT,
  description  TEXT,
  started_at   TIMESTAMPTZ NOT NULL,
  ended_at     TIMESTAMPTZ,             -- NULL while the timer runs
  minutes      INTEGER,                 -- NULL while the timer runs
  rate_minor   BIGINT NOT NULL DEFAULT 0, -- per hour
  currency     TEXT NOT NULL DEFAULT 'USD',
  billable     BOOLEAN NOT NULL DEFAULT TRUE,
  invoice_id   TEXT,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX ASYNC IF NOT EXISTS idx_time_entries_user_started ON time_entries (user_id, started_at);
CREATE INDEX ASYNC IF NOT EXISTS idx_time_entries_user_ref ON time_entries (user_id, ref_kind, ref_id);
CREATE INDEX ASYNC IF NOT EXISTS idx_time_entries_member_open ON time_entries (user_id, member_id, ended_at);

-- ── change_orders ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS change_orders (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  quote_id     TEXT,
  invoice_id   TEXT,
  number       INTEGER NOT NULL,
  title        TEXT NOT NULL,
  description  TEXT,
  items        TEXT NOT NULL DEFAULT '[]', -- JSON [{description, qty, unit_minor, tax_rate_bp, product_id?}]
  delta_minor  BIGINT NOT NULL DEFAULT 0,  -- total of items (may be negative for credits)
  currency     TEXT NOT NULL DEFAULT 'USD',
  status       TEXT NOT NULL DEFAULT 'draft', -- draft|sent|accepted|rejected
  accepted_at  TIMESTAMPTZ,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_at   TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX ASYNC IF NOT EXISTS idx_change_orders_user_created ON change_orders (user_id, created_at);
CREATE INDEX ASYNC IF NOT EXISTS idx_change_orders_quote ON change_orders (user_id, quote_id);
CREATE INDEX ASYNC IF NOT EXISTS idx_change_orders_invoice ON change_orders (user_id, invoice_id);

-- ── co_counters: per-org change-order numbering ─────────────────────────────
CREATE TABLE IF NOT EXISTS co_counters (
  user_id      TEXT PRIMARY KEY,
  next_number  INTEGER NOT NULL DEFAULT 1
);


-- ==== PHASE 3 LANE D ====
-- Phase 3 / Lane D: CSV import jobs, web push subscriptions, crew links
-- DSQL: one DDL per transaction, CREATE INDEX ASYNC only, no foreign keys.

-- ── import_jobs: one row per CSV import (dry runs included) ──────────────────
CREATE TABLE IF NOT EXISTS import_jobs (
  id            TEXT        NOT NULL DEFAULT gen_random_uuid()::text,
  user_id       TEXT        NOT NULL,            -- org data id
  actor_id      TEXT,                            -- signed-in user who ran it
  target        TEXT        NOT NULL,            -- crm_contacts|leads|tasks|products|expenses
  status        TEXT        NOT NULL DEFAULT 'done', -- dry_run|done|failed
  dry_run       BOOLEAN     NOT NULL DEFAULT FALSE,
  row_count     INTEGER     NOT NULL DEFAULT 0,
  inserted      INTEGER     NOT NULL DEFAULT 0,
  skipped       INTEGER     NOT NULL DEFAULT 0,
  error_count   INTEGER     NOT NULL DEFAULT 0,
  mapping       TEXT        NOT NULL DEFAULT '{}', -- JSON {field: header}
  errors        TEXT        NOT NULL DEFAULT '[]', -- JSON array (first 50)
  file_name     TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (id)
);

CREATE INDEX ASYNC IF NOT EXISTS import_jobs_user_created ON import_jobs(user_id, created_at);

-- ── push_subscriptions: Web Push endpoints per device ────────────────────────
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id          TEXT        NOT NULL DEFAULT gen_random_uuid()::text,
  user_id     TEXT        NOT NULL,              -- org data id (deliverPushForUser key)
  member_id   TEXT,                              -- signed-in user who subscribed
  endpoint    TEXT        NOT NULL,
  keys        TEXT        NOT NULL,              -- JSON {p256dh, auth}
  user_agent  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (id)
);

CREATE UNIQUE INDEX ASYNC IF NOT EXISTS push_subscriptions_endpoint ON push_subscriptions(endpoint);

CREATE INDEX ASYNC IF NOT EXISTS push_subscriptions_user ON push_subscriptions(user_id);

-- ── crew links reuse share_tokens (kind = 'crew'); add a human label ─────────
ALTER TABLE share_tokens ADD COLUMN IF NOT EXISTS label TEXT;


-- ==== PHASE 3 LANE E ====
-- ── Phase 3 / Lane E: white-label org branding ──────────────────────────────
-- One row per org, keyed by the org's data id (owner_user_id) like every other
-- module table. Org locale / currency / timezone live in organizations.settings
-- (JSON TEXT) and need no migration.

CREATE TABLE IF NOT EXISTS org_branding (
  user_id        TEXT PRIMARY KEY,
  brand_name     TEXT,
  logo_url       TEXT,
  primary_color  TEXT,                 -- #rrggbb
  accent_color   TEXT,                 -- #rrggbb
  email_footer   TEXT,
  custom_domain  TEXT,
  support_email  TEXT,
  favicon_url    TEXT,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


-- ==== PHASE 4 LANE A ====
-- Phase 4 / Lane A: public REST API v1 + outbound webhooks
-- DSQL rules: no FKs, JSON as TEXT, CREATE INDEX ASYNC, one DDL per transaction.

-- Idempotency store for POST /api/v1/* with an `Idempotency-Key` header.
-- Rows older than 24h are ignored and lazily deleted.
CREATE TABLE IF NOT EXISTS api_idempotency (
  id            TEXT        NOT NULL DEFAULT gen_random_uuid()::text,
  user_id       TEXT        NOT NULL,
  key           TEXT        NOT NULL,
  request_hash  TEXT        NOT NULL,           -- sha256(method + path + body)
  status        TEXT        NOT NULL DEFAULT 'pending', -- pending|completed
  response_json TEXT,                           -- {"status":201,"body":{...}}
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (id)
);

CREATE UNIQUE INDEX ASYNC IF NOT EXISTS api_idempotency_user_key ON api_idempotency(user_id, key);

CREATE INDEX ASYNC IF NOT EXISTS api_idempotency_created ON api_idempotency(created_at);

-- Outbound webhook subscriptions (one row per endpoint).
CREATE TABLE IF NOT EXISTS webhook_subscriptions (
  id              TEXT        NOT NULL DEFAULT gen_random_uuid()::text,
  user_id         TEXT        NOT NULL,          -- org data id (owner_user_id)
  url             TEXT        NOT NULL,
  secret          TEXT        NOT NULL,          -- "v1:…" encrypted (secure-store) or "plain:…"
  event_types     TEXT        NOT NULL DEFAULT '["*"]', -- JSON array; "*" = everything
  active          BOOLEAN     NOT NULL DEFAULT TRUE,
  description     TEXT,
  created_by      TEXT,                          -- user id or "api_key:<id>"
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_success_at TIMESTAMPTZ,
  last_failure_at TIMESTAMPTZ,
  failure_count   INTEGER     NOT NULL DEFAULT 0, -- consecutive failures; 20 auto-disables
  PRIMARY KEY (id)
);

CREATE INDEX ASYNC IF NOT EXISTS webhook_subscriptions_user ON webhook_subscriptions(user_id, active);

-- One delivery attempt record per (subscription, event). Retried in place.
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id              TEXT        NOT NULL DEFAULT gen_random_uuid()::text,
  user_id         TEXT        NOT NULL,
  subscription_id TEXT        NOT NULL,
  event_id        TEXT,                          -- events.id (NULL for test pings)
  event_type      TEXT        NOT NULL,
  payload         TEXT        NOT NULL,          -- JSON body exactly as signed/sent
  status          TEXT        NOT NULL DEFAULT 'queued', -- queued|delivering|delivered|failed|dead
  attempts        INTEGER     NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  response_status INTEGER,
  response_ms     INTEGER,
  error           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  delivered_at    TIMESTAMPTZ,
  PRIMARY KEY (id)
);

CREATE INDEX ASYNC IF NOT EXISTS webhook_deliveries_due ON webhook_deliveries(status, next_attempt_at);

CREATE INDEX ASYNC IF NOT EXISTS webhook_deliveries_sub ON webhook_deliveries(subscription_id, created_at);

CREATE INDEX ASYNC IF NOT EXISTS webhook_deliveries_user ON webhook_deliveries(user_id, created_at);

-- Fan-out watermark: the last `events` row turned into deliveries.
CREATE TABLE IF NOT EXISTS webhook_cursors (
  name               TEXT        NOT NULL,       -- 'events'
  last_event_at      TIMESTAMPTZ,
  last_event_id      TEXT,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (name)
);

-- Keyset pagination for the public API reads (created_at DESC, id DESC).
CREATE INDEX ASYNC IF NOT EXISTS crm_contacts_user_created ON crm_contacts(user_id, created_at, id);

CREATE INDEX ASYNC IF NOT EXISTS events_user_created_id ON events(user_id, created_at, id);


-- ==== PHASE 4 LANE B ====
-- ── Phase 4 / Lane B: AI credits, outcome pricing, eval harness, corrections-as-memory ──
-- DSQL dialect: TEXT ids, no FKs, CREATE INDEX ASYNC, no partial indexes.

-- ── Credits ──────────────────────────────────────────────────────────────────

-- One row per user; `balance` is the single source of truth for the current
-- balance. Writers update it with `WHERE balance = <expected>` (optimistic
-- concurrency) and only then append the ledger row, so two parallel charges
-- can never both read the same starting balance and both win.
CREATE TABLE IF NOT EXISTS ai_credit_accounts (
  user_id     TEXT PRIMARY KEY,
  balance     BIGINT NOT NULL DEFAULT 0,          -- credits; 1 credit = 1/1000 USD
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Append-only ledger. `credits` is signed (purchases/grants positive, usage/
-- outcome negative); `balance_after` is the account balance once this row
-- was applied, so the history is auditable without replaying it.
CREATE TABLE IF NOT EXISTS ai_credit_ledger (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL,
  kind           TEXT NOT NULL,                    -- purchase|grant|usage|outcome|refund|adjustment
  credits        BIGINT NOT NULL,
  balance_after  BIGINT NOT NULL,
  ref_kind       TEXT,                             -- usage|run|purchase|signup|manual
  ref_id         TEXT,
  note           TEXT,
  created_at     TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX ASYNC IF NOT EXISTS idx_ai_credit_ledger_user ON ai_credit_ledger (user_id, created_at);
-- Idempotency: one ledger row per (kind, ref). Outcome charges key on the run
-- id, purchases on the purchase id, the free grant on the user id.
CREATE UNIQUE INDEX ASYNC IF NOT EXISTS idx_ai_credit_ledger_ref ON ai_credit_ledger (user_id, kind, ref_kind, ref_id);

-- Credit pack purchases. The pack catalog itself lives in code
-- (src/lib/credits/packs.ts). `token_hash` is the sha256 of the public
-- checkout token used by /p/credits/<token>, mirroring share_tokens.
CREATE TABLE IF NOT EXISTS ai_credit_purchases (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL,
  pack_id       TEXT NOT NULL,
  credits       BIGINT NOT NULL,
  amount_minor  BIGINT NOT NULL,
  currency      TEXT NOT NULL DEFAULT 'USD',
  provider      TEXT NOT NULL,                     -- simulated|stripe|razorpay
  provider_ref  TEXT,
  status        TEXT NOT NULL DEFAULT 'pending',   -- pending|paid|failed
  token_hash    TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  paid_at       TIMESTAMPTZ
);
CREATE INDEX ASYNC IF NOT EXISTS idx_ai_credit_purchases_user ON ai_credit_purchases (user_id, created_at);
CREATE INDEX ASYNC IF NOT EXISTS idx_ai_credit_purchases_ref ON ai_credit_purchases (provider, provider_ref);
CREATE UNIQUE INDEX ASYNC IF NOT EXISTS idx_ai_credit_purchases_token ON ai_credit_purchases (token_hash);

-- Enforcement toggle: when on, model calls stop once the balance is exhausted.
ALTER TABLE ai_budgets ADD COLUMN IF NOT EXISTS credits_enforced BOOLEAN DEFAULT FALSE;

-- Outcome pricing: charge `outcome_price_credits` once per run that ends with
-- `outcome_event` (an events-bus type such as booking.created) having fired.
ALTER TABLE agents ADD COLUMN IF NOT EXISTS outcome_event TEXT;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS outcome_price_credits BIGINT;

-- ── Evaluation harness ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS agent_evals (
  id          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id     TEXT NOT NULL,
  agent_id    TEXT NOT NULL,                       -- agents.id (uuid as text)
  name        TEXT NOT NULL,
  cases       TEXT NOT NULL DEFAULT '[]',          -- JSON [{ input, expected, rubric }]
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX ASYNC IF NOT EXISTS idx_agent_evals_agent ON agent_evals (user_id, agent_id, created_at);

CREATE TABLE IF NOT EXISTS agent_eval_runs (
  id           TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id      TEXT NOT NULL,
  eval_id      TEXT NOT NULL,
  agent_id     TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'queued',     -- queued|running|done|failed
  score        INTEGER,                            -- 0..100 mean across cases
  results      TEXT,                               -- JSON [{ idx, input, expected, output, score, reasons, transcript, cost_micros }]
  model        TEXT,
  cost_micros  BIGINT DEFAULT 0,
  error        TEXT,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  finished_at  TIMESTAMPTZ
);
CREATE INDEX ASYNC IF NOT EXISTS idx_agent_eval_runs_eval ON agent_eval_runs (user_id, eval_id, created_at);

-- ── Corrections-as-memory ────────────────────────────────────────────────────
-- `agent_corrections` already exists (original_text / corrected_text / context);
-- extend it with provenance and the vector reference.
ALTER TABLE agent_corrections ADD COLUMN IF NOT EXISTS run_id TEXT;
ALTER TABLE agent_corrections ADD COLUMN IF NOT EXISTS step_id TEXT;
ALTER TABLE agent_corrections ADD COLUMN IF NOT EXISTS note TEXT;
ALTER TABLE agent_corrections ADD COLUMN IF NOT EXISTS embedding_ref TEXT;   -- pinecone file id: corr:<id>


-- ==== PHASE 4 LANE C ====
-- ==== PHASE 4 LANE C: marketplace, e-sign / PDF fingerprints, quote lifecycle ====
-- DSQL rules: no FKs, JSON stored as TEXT, CREATE INDEX ASYNC, one DDL per statement,
-- no DEFAULT on ADD COLUMN (the app fills values).
-- All tables are keyed by user_id = organizations.owner_user_id (requireScope().dataId).

-- ── marketplace_listings: portable agents / playbooks / automations / record packs ──
CREATE TABLE IF NOT EXISTS marketplace_listings (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL,                 -- publisher org data id
  kind           TEXT NOT NULL,                 -- agent|playbook|automation|pack
  slug           TEXT NOT NULL,
  title          TEXT NOT NULL,
  summary        TEXT,
  description_md TEXT,
  category       TEXT,
  tags           TEXT NOT NULL DEFAULT '[]',    -- JSON array of strings
  definition     TEXT NOT NULL DEFAULT '{}',    -- JSON: the portable spec (see src/lib/marketplace/types.ts)
  version        INTEGER NOT NULL DEFAULT 1,
  visibility     TEXT NOT NULL DEFAULT 'private', -- private|org|public
  install_count  INTEGER NOT NULL DEFAULT 0,
  rating_sum     INTEGER NOT NULL DEFAULT 0,
  rating_count   INTEGER NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  updated_at     TIMESTAMPTZ DEFAULT NOW(),
  published_at   TIMESTAMPTZ
);
CREATE UNIQUE INDEX ASYNC IF NOT EXISTS idx_marketplace_listings_user_slug ON marketplace_listings (user_id, slug);
CREATE INDEX ASYNC IF NOT EXISTS idx_marketplace_listings_visibility ON marketplace_listings (visibility, kind, published_at);
CREATE INDEX ASYNC IF NOT EXISTS idx_marketplace_listings_user ON marketplace_listings (user_id, updated_at);

-- ── marketplace_installs: which org installed what (idempotent per listing+version) ──
CREATE TABLE IF NOT EXISTS marketplace_installs (
  id                     TEXT PRIMARY KEY,
  user_id                TEXT NOT NULL,         -- installing org data id
  listing_id             TEXT NOT NULL,         -- marketplace_listings.id or a builtin:* id
  version                INTEGER NOT NULL DEFAULT 1,
  installed_entity_kind  TEXT NOT NULL,         -- agent|playbook|automation|pack
  installed_entity_id    TEXT NOT NULL,
  created_at             TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX ASYNC IF NOT EXISTS idx_marketplace_installs_user_listing ON marketplace_installs (user_id, listing_id, version);

-- ── marketplace_reviews ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS marketplace_reviews (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,                    -- reviewing org data id
  listing_id  TEXT NOT NULL,
  rating      INTEGER NOT NULL,                 -- 1..5
  body        TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX ASYNC IF NOT EXISTS idx_marketplace_reviews_listing ON marketplace_reviews (listing_id, created_at);
CREATE UNIQUE INDEX ASYNC IF NOT EXISTS idx_marketplace_reviews_user_listing ON marketplace_reviews (user_id, listing_id);

-- ── e-sign: typed signature + document fingerprints on acceptances ──────────
ALTER TABLE quote_acceptances ADD COLUMN IF NOT EXISTS signature_text TEXT;
ALTER TABLE quote_acceptances ADD COLUMN IF NOT EXISTS document_hash TEXT;         -- sha256 of the unsigned PDF bytes
ALTER TABLE quote_acceptances ADD COLUMN IF NOT EXISTS signed_document_hash TEXT;  -- sha256 of the stamped PDF bytes

-- ── quote lifecycle: decline / expiry bookkeeping ───────────────────────────
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS declined_at TIMESTAMPTZ;
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS decline_reason TEXT;
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS expired_at TIMESTAMPTZ;
CREATE INDEX ASYNC IF NOT EXISTS idx_quotes_status_valid_until ON quotes (status, valid_until);


-- ==== PHASE 4 LANE D ====
-- ── Phase 4 / Lane D: email inbox sync + outbound voice campaigns ────────────
-- DSQL: one DDL per statement, no FKs, JSON as TEXT, CREATE INDEX ASYNC.

-- Mail accounts (OAuth / simulated). `auth` is encrypted via src/lib/secure-store.ts.
CREATE TABLE IF NOT EXISTS mail_accounts (
  id            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id       TEXT NOT NULL,
  provider      TEXT NOT NULL,                 -- gmail | outlook | imap | simulated
  email         TEXT NOT NULL,
  display_name  TEXT,
  auth          TEXT,                          -- encrypted JSON: {access_token, refresh_token, expires_at} or imap creds
  sync_cursor   TEXT,                          -- Gmail historyId / Graph deltaLink / IMAP uidnext
  status        TEXT NOT NULL DEFAULT 'connected', -- connected | error | disabled
  last_sync_at  TIMESTAMPTZ,
  last_error    TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX ASYNC IF NOT EXISTS idx_mail_accounts_user ON mail_accounts (user_id);

CREATE TABLE IF NOT EXISTS mail_messages (
  id                  TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id             TEXT NOT NULL,
  account_id          TEXT NOT NULL,
  provider_message_id TEXT NOT NULL,
  thread_id           TEXT,
  conversation_id     TEXT,                    -- messaging_conversations.id
  direction           TEXT NOT NULL DEFAULT 'in', -- in | out
  from_addr           TEXT,
  to_addrs            TEXT NOT NULL DEFAULT '[]', -- JSON array of addresses
  subject             TEXT,
  snippet             TEXT,
  body_text           TEXT,
  body_html           TEXT,
  received_at         TIMESTAMPTZ,
  is_read             BOOLEAN NOT NULL DEFAULT FALSE,
  labels              TEXT NOT NULL DEFAULT '[]', -- JSON array
  created_at          TIMESTAMPTZ DEFAULT NOW()
);
CREATE UNIQUE INDEX ASYNC IF NOT EXISTS uq_mail_messages_account_provider ON mail_messages (account_id, provider_message_id);
CREATE INDEX ASYNC IF NOT EXISTS idx_mail_messages_user_received ON mail_messages (user_id, received_at);
CREATE INDEX ASYNC IF NOT EXISTS idx_mail_messages_conversation ON mail_messages (conversation_id);

-- Email threads map onto the unified inbox; these columns let a thread be found again.
ALTER TABLE messaging_conversations ADD COLUMN IF NOT EXISTS thread_key TEXT;
ALTER TABLE messaging_conversations ADD COLUMN IF NOT EXISTS contact_id TEXT;
CREATE INDEX ASYNC IF NOT EXISTS idx_messaging_conv_thread ON messaging_conversations (user_id, thread_key);

-- Outbound voice campaigns
CREATE TABLE IF NOT EXISTS voice_campaigns (
  id            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id       TEXT NOT NULL,
  name          TEXT NOT NULL,
  script        TEXT NOT NULL,                 -- supports {{first_name}} {{full_name}} {{company}}
  voice         TEXT NOT NULL DEFAULT 'Polly.Joanna',
  status        TEXT NOT NULL DEFAULT 'draft', -- draft | scheduled | running | paused | done
  schedule_at   TIMESTAMPTZ,
  window_start  TEXT NOT NULL DEFAULT '09:00', -- HH:MM local to `timezone`
  window_end    TEXT NOT NULL DEFAULT '18:00',
  timezone      TEXT NOT NULL DEFAULT 'UTC',
  max_attempts  INTEGER NOT NULL DEFAULT 2,
  created_by    TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX ASYNC IF NOT EXISTS idx_voice_campaigns_user_status ON voice_campaigns (user_id, status);

CREATE TABLE IF NOT EXISTS voice_campaign_targets (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id         TEXT NOT NULL,
  campaign_id     TEXT NOT NULL,
  contact_id      TEXT,
  phone           TEXT NOT NULL,
  first_name      TEXT,
  status          TEXT NOT NULL DEFAULT 'queued', -- queued | calling | answered | voicemail | no_answer | failed | opted_out | done
  attempts        INTEGER NOT NULL DEFAULT 0,
  last_attempt_at TIMESTAMPTZ,
  call_sid        TEXT,
  outcome         TEXT,                        -- JSON: {digits, answered_by, duration_s, simulated, ...}
  created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX ASYNC IF NOT EXISTS idx_voice_targets_campaign_status ON voice_campaign_targets (campaign_id, status);
CREATE INDEX ASYNC IF NOT EXISTS idx_voice_targets_user ON voice_campaign_targets (user_id);

CREATE TABLE IF NOT EXISTS voice_calls (
  id            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id       TEXT NOT NULL,
  campaign_id   TEXT,
  target_id     TEXT,
  call_sid      TEXT,
  direction     TEXT NOT NULL DEFAULT 'outbound',
  status        TEXT NOT NULL DEFAULT 'queued', -- queued | in_progress | completed | no_answer | busy | failed | simulated
  duration_s    INTEGER,
  recording_url TEXT,
  transcript    TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX ASYNC IF NOT EXISTS idx_voice_calls_user_created ON voice_calls (user_id, created_at);
CREATE INDEX ASYNC IF NOT EXISTS idx_voice_calls_campaign ON voice_calls (campaign_id);

-- Do-not-call / do-not-contact list
CREATE TABLE IF NOT EXISTS contact_optouts (
  id          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id     TEXT NOT NULL,
  contact_id  TEXT,
  phone       TEXT,
  email       TEXT,
  channel     TEXT NOT NULL DEFAULT 'voice',  -- voice | sms | email | all
  reason      TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX ASYNC IF NOT EXISTS idx_contact_optouts_user_phone ON contact_optouts (user_id, phone);


-- ==== PHASE 4 LANE E ====
-- ==== PHASE 4 LANE E: agency mode, SCIM 2.0 / SSO readiness, optimization AI ====
-- DSQL rules: no FKs, JSON stored as TEXT, CREATE INDEX ASYNC, one DDL per statement.

-- ── organizations: agency hierarchy ─────────────────────────────────────────
-- kind: standard | agency | client. A client org is owned by an agency org
-- (parent_org_id) and its owner_user_id is a synthetic data id equal to the
-- client org's own id (see src/lib/agency/orgs.ts). archived_at soft-deletes.
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS parent_org_id TEXT;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS kind TEXT DEFAULT 'standard';
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;
CREATE INDEX ASYNC IF NOT EXISTS idx_organizations_parent ON organizations (parent_org_id);

-- ── scim_tokens: bearer tokens for the SCIM 2.0 provisioning endpoint ───────
-- user_id is the org data id (organizations.owner_user_id). Only the SHA-256
-- of the token is stored; the plaintext is shown once at creation.
CREATE TABLE IF NOT EXISTS scim_tokens (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  name         TEXT NOT NULL,
  token_hash   TEXT NOT NULL,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  last_used_at TIMESTAMPTZ,
  revoked_at   TIMESTAMPTZ
);
CREATE UNIQUE INDEX ASYNC IF NOT EXISTS idx_scim_tokens_hash ON scim_tokens (token_hash);
CREATE INDEX ASYNC IF NOT EXISTS idx_scim_tokens_user ON scim_tokens (user_id, revoked_at);

-- ── sso_domains: email domain → Supabase SAML provider id ───────────────────
CREATE TABLE IF NOT EXISTS sso_domains (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  domain      TEXT NOT NULL,
  provider_id TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE UNIQUE INDEX ASYNC IF NOT EXISTS idx_sso_domains_domain ON sso_domains (domain);
CREATE INDEX ASYNC IF NOT EXISTS idx_sso_domains_user ON sso_domains (user_id);

