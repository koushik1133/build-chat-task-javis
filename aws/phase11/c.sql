-- Phase 11 lane C: shipping, tracking and returns

CREATE TABLE IF NOT EXISTS shipping_connections (
  id               TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL,
  provider         TEXT NOT NULL,                        -- easypost | shippo (simulated needs no row)
  auth             TEXT,                                 -- secure-store encrypted JSON {api_key}
  ship_from        TEXT,                                 -- JSON address
  default_package  TEXT,                                 -- JSON {weight_grams,length_cm,width_cm,height_cm}
  status           TEXT NOT NULL DEFAULT 'active',       -- active|disabled
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX ASYNC IF NOT EXISTS idx_shipping_connections_user_provider ON shipping_connections (user_id, provider);

CREATE TABLE IF NOT EXISTS shipping_rules (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL,                             -- flat|weight_tiers|free_over|carrier_calculated
  config      TEXT NOT NULL DEFAULT '{}',                -- JSON per kind
  countries   TEXT NOT NULL DEFAULT '[]',                -- JSON array of ISO-2 / names; empty = everywhere
  active      BOOLEAN NOT NULL DEFAULT TRUE,
  sort        INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX ASYNC IF NOT EXISTS idx_shipping_rules_user ON shipping_rules (user_id, sort);

CREATE TABLE IF NOT EXISTS shipments (
  id                     TEXT PRIMARY KEY,
  user_id                TEXT NOT NULL,
  order_id               TEXT,
  return_id              TEXT,
  status                 TEXT NOT NULL DEFAULT 'draft',  -- draft|label_purchased|in_transit|out_for_delivery|delivered|exception|returned|void
  carrier                TEXT,
  service                TEXT,
  rate_minor             BIGINT NOT NULL DEFAULT 0,
  currency               TEXT NOT NULL DEFAULT 'USD',
  tracking_number        TEXT,
  tracking_url           TEXT,
  label_url_or_attachment_id TEXT,
  weight_grams           INTEGER,
  dimensions             TEXT,                           -- JSON {length_cm,width_cm,height_cm}
  to_address             TEXT,
  from_address           TEXT,
  items                  TEXT NOT NULL DEFAULT '[]',     -- JSON [{product_id,description,qty}]
  insured_minor          BIGINT NOT NULL DEFAULT 0,
  provider_ref           TEXT,
  purchased_at           TIMESTAMPTZ,
  delivered_at           TIMESTAMPTZ,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX ASYNC IF NOT EXISTS idx_shipments_user_created ON shipments (user_id, created_at);

CREATE INDEX ASYNC IF NOT EXISTS idx_shipments_order ON shipments (user_id, order_id);

CREATE UNIQUE INDEX ASYNC IF NOT EXISTS idx_shipments_tracking ON shipments (user_id, carrier, tracking_number);

CREATE TABLE IF NOT EXISTS shipment_events (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  shipment_id  TEXT NOT NULL,
  status       TEXT NOT NULL,
  description  TEXT,
  location     TEXT,
  occurred_at  TIMESTAMPTZ NOT NULL,
  raw_hash     TEXT
);

CREATE UNIQUE INDEX ASYNC IF NOT EXISTS idx_shipment_events_unique ON shipment_events (shipment_id, occurred_at, status);

CREATE INDEX ASYNC IF NOT EXISTS idx_shipment_events_user ON shipment_events (user_id, shipment_id);

CREATE TABLE IF NOT EXISTS return_requests (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  order_id    TEXT NOT NULL,
  contact_id  TEXT,
  status      TEXT NOT NULL DEFAULT 'requested',         -- requested|approved|rejected|label_sent|received|refunded|closed
  reason      TEXT,
  items       TEXT NOT NULL DEFAULT '[]',                -- JSON [{product_id,description,qty}]
  resolution  TEXT NOT NULL DEFAULT 'refund',            -- refund|exchange|store_credit
  notes       TEXT,
  refund_minor BIGINT NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX ASYNC IF NOT EXISTS idx_return_requests_user ON return_requests (user_id, created_at);

CREATE INDEX ASYNC IF NOT EXISTS idx_return_requests_order ON return_requests (user_id, order_id);

ALTER TABLE products ADD COLUMN IF NOT EXISTS weight_grams INTEGER;

ALTER TABLE products ADD COLUMN IF NOT EXISTS hs_code TEXT;

ALTER TABLE orders ADD COLUMN IF NOT EXISTS shipping_method TEXT;

ALTER TABLE orders ADD COLUMN IF NOT EXISTS shipping_quote TEXT;

ALTER TABLE storefronts ADD COLUMN IF NOT EXISTS return_window_days INTEGER;
