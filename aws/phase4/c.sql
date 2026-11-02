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
