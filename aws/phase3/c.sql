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
