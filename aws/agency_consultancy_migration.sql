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
