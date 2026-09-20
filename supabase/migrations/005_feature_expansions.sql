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
