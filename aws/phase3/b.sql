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
