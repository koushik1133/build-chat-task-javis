-- Phase 7 / Lane A: procurement (suppliers, purchase orders, receiving, supplier bills, bill payments)
-- DSQL rules: no FKs, no triggers, JSON as TEXT, CREATE INDEX ASYNC, one statement per block, no DEFAULT on ADD COLUMN.

-- ── suppliers ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS suppliers (
  id                  TEXT PRIMARY KEY,
  user_id             TEXT NOT NULL,
  name                TEXT NOT NULL,
  email               TEXT,
  phone               TEXT,
  tax_number          TEXT,
  address             TEXT,                       -- JSON {line1,line2,city,region,postal_code,country} or plain text
  payment_terms_days  INTEGER NOT NULL DEFAULT 30,
  currency            TEXT NOT NULL DEFAULT 'USD',
  notes               TEXT,
  active              BOOLEAN NOT NULL DEFAULT TRUE,
  deleted_at          TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX ASYNC IF NOT EXISTS idx_suppliers_user ON suppliers (user_id, deleted_at, name);

CREATE INDEX ASYNC IF NOT EXISTS idx_suppliers_user_created ON suppliers (user_id, created_at);

-- ── purchase_orders ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS purchase_orders (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL,
  supplier_id     TEXT NOT NULL,
  number          TEXT NOT NULL,                  -- PO-000001 via doc_counters kind purchase_order
  status          TEXT NOT NULL DEFAULT 'draft',  -- draft|sent|partially_received|received|cancelled
  items           TEXT NOT NULL DEFAULT '[]',     -- JSON [{description, qty, unit_minor, product_id, tax_rate_bp, tax_rate_id}]
  subtotal_minor  BIGINT NOT NULL DEFAULT 0,
  tax_minor       BIGINT NOT NULL DEFAULT 0,
  total_minor     BIGINT NOT NULL DEFAULT 0,
  currency        TEXT NOT NULL DEFAULT 'USD',
  expected_at     TIMESTAMPTZ,
  notes           TEXT,
  sent_at         TIMESTAMPTZ,
  received_at     TIMESTAMPTZ,
  created_by      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX ASYNC IF NOT EXISTS idx_purchase_orders_user_created ON purchase_orders (user_id, created_at);

CREATE INDEX ASYNC IF NOT EXISTS idx_purchase_orders_user_status ON purchase_orders (user_id, status, created_at);

CREATE INDEX ASYNC IF NOT EXISTS idx_purchase_orders_supplier ON purchase_orders (user_id, supplier_id);

-- ── po_receipts: one row per goods receipt against a PO ──────────────────────
CREATE TABLE IF NOT EXISTS po_receipts (
  id                 TEXT PRIMARY KEY,
  user_id            TEXT NOT NULL,
  purchase_order_id  TEXT NOT NULL,
  received_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  lines              TEXT NOT NULL DEFAULT '[]',  -- JSON [{product_id, qty}]
  note               TEXT,
  created_by         TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX ASYNC IF NOT EXISTS idx_po_receipts_po ON po_receipts (user_id, purchase_order_id, received_at);

-- ── supplier_bills (accounts payable) ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS supplier_bills (
  id                 TEXT PRIMARY KEY,
  user_id            TEXT NOT NULL,
  supplier_id        TEXT NOT NULL,
  purchase_order_id  TEXT,
  number             TEXT NOT NULL,               -- BILL-000001 via doc_counters kind supplier_bill
  supplier_ref       TEXT,                        -- the supplier's own invoice number
  status             TEXT NOT NULL DEFAULT 'draft', -- draft|open|partially_paid|paid|void
  items              TEXT NOT NULL DEFAULT '[]',
  subtotal_minor     BIGINT NOT NULL DEFAULT 0,
  tax_minor          BIGINT NOT NULL DEFAULT 0,
  total_minor        BIGINT NOT NULL DEFAULT 0,
  currency           TEXT NOT NULL DEFAULT 'USD',
  issued_at          TIMESTAMPTZ,
  due_at             TIMESTAMPTZ,
  paid_minor         BIGINT NOT NULL DEFAULT 0,
  paid_at            TIMESTAMPTZ,
  notes              TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX ASYNC IF NOT EXISTS idx_supplier_bills_user_created ON supplier_bills (user_id, created_at);

CREATE INDEX ASYNC IF NOT EXISTS idx_supplier_bills_user_status_due ON supplier_bills (user_id, status, due_at);

CREATE INDEX ASYNC IF NOT EXISTS idx_supplier_bills_supplier ON supplier_bills (user_id, supplier_id);

CREATE INDEX ASYNC IF NOT EXISTS idx_supplier_bills_po ON supplier_bills (user_id, purchase_order_id);

-- ── bill_payments ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bill_payments (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL,
  bill_id       TEXT NOT NULL,
  amount_minor  BIGINT NOT NULL,
  currency      TEXT NOT NULL DEFAULT 'USD',
  paid_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  method        TEXT,                             -- bank|card|cash|cheque|other
  ref           TEXT,
  note          TEXT,
  expense_id    TEXT,                             -- the expenses row this payment created
  created_by    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX ASYNC IF NOT EXISTS idx_bill_payments_bill ON bill_payments (user_id, bill_id, paid_at);

-- ── products: preferred supplier + last purchase cost ────────────────────────
ALTER TABLE products ADD COLUMN IF NOT EXISTS preferred_supplier_id TEXT;

ALTER TABLE products ADD COLUMN IF NOT EXISTS last_cost_minor BIGINT;

CREATE INDEX ASYNC IF NOT EXISTS idx_products_preferred_supplier ON products (user_id, preferred_supplier_id);
