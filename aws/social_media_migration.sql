-- ─────────────────────────────────────────────────────────────────────────────
-- Javis — Social Media Employee Module migration
-- Run via: node scripts/run-migrations.mjs  (after appending to migrations.sql)
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

CREATE INDEX IF NOT EXISTS social_brands_user_id ON social_brands(user_id);

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

CREATE INDEX IF NOT EXISTS social_accounts_user_id ON social_accounts(user_id);

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

CREATE INDEX IF NOT EXISTS social_posts_user_id ON social_posts(user_id);
CREATE INDEX IF NOT EXISTS social_posts_status ON social_posts(status);
CREATE INDEX IF NOT EXISTS social_posts_scheduled_at ON social_posts(scheduled_at);

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

CREATE INDEX IF NOT EXISTS social_ideas_user_id ON social_ideas(user_id);
