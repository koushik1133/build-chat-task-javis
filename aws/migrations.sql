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

-- ==== PHASE 2 LANE C: payments, quotes, invoices ====

-- ==== PHASE 2 LANE D: calendar, booking, client portal ====

-- ==== PHASE 2 LANE E: security ====
