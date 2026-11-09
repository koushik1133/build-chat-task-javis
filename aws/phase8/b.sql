-- Phase 8 / Lane B: public storefront, carts, orders
-- DSQL rules: no FKs, no triggers, JSON as TEXT, CREATE INDEX ASYNC, one statement per block, no DEFAULT on ADD COLUMN.

-- ── storefronts: one per org (user_id = org owner / data id) ────────────────
CREATE TABLE IF NOT EXISTS storefronts (
  user_id             TEXT PRIMARY KEY,
  enabled             BOOLEAN NOT NULL DEFAULT FALSE,
  slug                TEXT NOT NULL,                  -- defaults to organizations.slug
  title               TEXT,
  intro_md            TEXT,
  currency            TEXT NOT NULL DEFAULT 'USD',
  collect_shipping    BOOLEAN NOT NULL DEFAULT FALSE,
  shipping_flat_minor BIGINT NOT NULL DEFAULT 0,
  pickup_enabled      BOOLEAN NOT NULL DEFAULT TRUE,
  terms_md            TEXT,
  settings            TEXT,                           -- JSON {max_qty_per_line, cart_ttl_hours, ...}
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX ASYNC IF NOT EXISTS idx_storefronts_slug ON storefronts (slug);

-- ── storefront_products: which pricebook products are listed publicly ───────
CREATE TABLE IF NOT EXISTS storefront_products (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL,
  product_id      TEXT NOT NULL,
  visible         BOOLEAN NOT NULL DEFAULT FALSE,
  sort            INTEGER NOT NULL DEFAULT 0,
  description_md  TEXT,
  image_url       TEXT,                               -- absolute URL or attachments id (entity_kind product, visibility portal)
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX ASYNC IF NOT EXISTS uq_storefront_products_product ON storefront_products (user_id, product_id);

CREATE INDEX ASYNC IF NOT EXISTS idx_storefront_products_visible ON storefront_products (user_id, visible, sort);

-- ── carts: anonymous shopper carts (token hashed, cookie kh_cart_<slug>) ────
CREATE TABLE IF NOT EXISTS carts (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  token_hash  TEXT NOT NULL,
  items       TEXT NOT NULL DEFAULT '[]',             -- JSON [{product_id, qty}]
  email       TEXT,
  reminded_at TIMESTAMPTZ,                            -- abandoned-cart sweep marker (idempotency)
  order_id    TEXT,                                   -- set once checked out
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at  TIMESTAMPTZ NOT NULL
);

CREATE UNIQUE INDEX ASYNC IF NOT EXISTS uq_carts_token ON carts (token_hash);

CREATE INDEX ASYNC IF NOT EXISTS idx_carts_user_updated ON carts (user_id, updated_at);

CREATE INDEX ASYNC IF NOT EXISTS idx_carts_abandoned ON carts (reminded_at, order_id, updated_at);

-- ── orders ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS orders (
  id                TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL,
  number            TEXT NOT NULL,                    -- ORD-000001 via doc_counters kind order
  status            TEXT NOT NULL DEFAULT 'pending_payment', -- pending_payment|paid|fulfilled|cancelled|refunded
  customer_name     TEXT NOT NULL,
  customer_email    TEXT NOT NULL,
  customer_phone    TEXT,
  shipping_address  TEXT,                             -- JSON {line1,line2,city,region,postal_code,country} or null (pickup)
  items             TEXT NOT NULL DEFAULT '[]',       -- JSON LineItem[] (+ product_id, name)
  subtotal_minor    BIGINT NOT NULL DEFAULT 0,
  tax_minor         BIGINT NOT NULL DEFAULT 0,
  shipping_minor    BIGINT NOT NULL DEFAULT 0,
  total_minor       BIGINT NOT NULL DEFAULT 0,
  currency          TEXT NOT NULL DEFAULT 'USD',
  tax_breakdown     TEXT,                             -- JSON TaxBreakdownRow[]
  contact_id        TEXT,
  invoice_id        TEXT,
  cart_id           TEXT,
  payment_ref       TEXT,
  consent_marketing BOOLEAN NOT NULL DEFAULT FALSE,
  notes             TEXT,
  paid_at           TIMESTAMPTZ,
  fulfilled_at      TIMESTAMPTZ,
  cancelled_at      TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX ASYNC IF NOT EXISTS idx_orders_user_created ON orders (user_id, created_at);

CREATE INDEX ASYNC IF NOT EXISTS idx_orders_user_status ON orders (user_id, status, created_at);

CREATE INDEX ASYNC IF NOT EXISTS idx_orders_invoice ON orders (invoice_id);

CREATE INDEX ASYNC IF NOT EXISTS idx_orders_user_email ON orders (user_id, customer_email);
