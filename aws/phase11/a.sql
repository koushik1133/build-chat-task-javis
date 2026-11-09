-- Phase 11 lane A: multi-location inventory, transfers and stock counts.
-- DSQL rules: no FKs, JSON as TEXT, CREATE INDEX ASYNC, one DDL per statement.

CREATE TABLE IF NOT EXISTS locations (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  name        TEXT NOT NULL,
  code        TEXT,
  kind        TEXT NOT NULL DEFAULT 'warehouse',   -- store|warehouse|van|virtual
  address     TEXT,                                 -- JSON
  active      BOOLEAN NOT NULL DEFAULT TRUE,
  is_default  BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX ASYNC IF NOT EXISTS idx_locations_user ON locations (user_id, active);

CREATE TABLE IF NOT EXISTS stock_levels (
  user_id        TEXT NOT NULL,
  product_id     TEXT NOT NULL,
  location_id    TEXT NOT NULL,
  on_hand        INTEGER NOT NULL DEFAULT 0,
  reserved       INTEGER NOT NULL DEFAULT 0,
  reorder_point  INTEGER,                           -- per-location override (NULL = none)
  updated_at     TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (user_id, product_id, location_id)
);

CREATE INDEX ASYNC IF NOT EXISTS idx_stock_levels_location ON stock_levels (user_id, location_id);

ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS location_id TEXT;

ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS transfer_id TEXT;

CREATE TABLE IF NOT EXISTS stock_transfers (
  id                TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL,
  number            TEXT NOT NULL,                  -- TRF-000001 via doc_counters kind transfer
  from_location_id  TEXT NOT NULL,
  to_location_id    TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'draft',  -- draft|in_transit|received|cancelled
  note              TEXT,
  created_by        TEXT,
  shipped_at        TIMESTAMPTZ,
  received_at       TIMESTAMPTZ,
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX ASYNC IF NOT EXISTS idx_stock_transfers_user ON stock_transfers (user_id, status, created_at);

CREATE TABLE IF NOT EXISTS stock_transfer_lines (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL,
  transfer_id   TEXT NOT NULL,
  product_id    TEXT NOT NULL,
  qty           INTEGER NOT NULL,
  received_qty  INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX ASYNC IF NOT EXISTS idx_stock_transfer_lines_transfer ON stock_transfer_lines (user_id, transfer_id);

CREATE TABLE IF NOT EXISTS stock_counts (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  location_id  TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'open',        -- open|counted|applied
  created_by   TEXT,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  applied_at   TIMESTAMPTZ
);

CREATE INDEX ASYNC IF NOT EXISTS idx_stock_counts_user ON stock_counts (user_id, created_at);

CREATE TABLE IF NOT EXISTS stock_count_lines (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL,
  count_id      TEXT NOT NULL,
  product_id    TEXT NOT NULL,
  expected_qty  INTEGER NOT NULL DEFAULT 0,
  counted_qty   INTEGER
);

CREATE INDEX ASYNC IF NOT EXISTS idx_stock_count_lines_count ON stock_count_lines (user_id, count_id);

ALTER TABLE storefronts ADD COLUMN IF NOT EXISTS fulfil_location_id TEXT;
