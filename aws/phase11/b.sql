-- ==== PHASE 11 LANE B: customer subscriptions & memberships ====
CREATE TABLE IF NOT EXISTS membership_plans (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL,
  slug            TEXT NOT NULL,
  name            TEXT NOT NULL,
  description_md  TEXT,
  amount_minor    BIGINT NOT NULL DEFAULT 0,
  currency        TEXT NOT NULL DEFAULT 'USD',
  interval        TEXT NOT NULL DEFAULT 'month',      -- week|month|quarter|year
  interval_count  INTEGER NOT NULL DEFAULT 1,
  trial_days      INTEGER NOT NULL DEFAULT 0,
  setup_fee_minor BIGINT NOT NULL DEFAULT 0,
  tax_rate_id     TEXT,
  product_id      TEXT,
  max_members     INTEGER,
  allow_pause     BOOLEAN NOT NULL DEFAULT TRUE,
  allow_quantity  BOOLEAN NOT NULL DEFAULT FALSE,
  benefits        TEXT,                                -- JSON [{label}]
  visibility      TEXT NOT NULL DEFAULT 'public',      -- public|private
  active          BOOLEAN NOT NULL DEFAULT TRUE,
  sort            INTEGER NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE UNIQUE INDEX ASYNC IF NOT EXISTS uq_membership_plans_user_slug ON membership_plans (user_id, slug);
CREATE INDEX ASYNC IF NOT EXISTS idx_membership_plans_user_sort ON membership_plans (user_id, sort);

CREATE TABLE IF NOT EXISTS customer_subscriptions (
  id                    TEXT PRIMARY KEY,
  user_id               TEXT NOT NULL,
  plan_id               TEXT NOT NULL,
  contact_id            TEXT NOT NULL,
  status                TEXT NOT NULL,                 -- incomplete|trialing|active|past_due|paused|cancelled|expired
  quantity              INTEGER NOT NULL,
  start_at              TIMESTAMPTZ NOT NULL,
  trial_ends_at         TIMESTAMPTZ,
  current_period_start  TIMESTAMPTZ,
  current_period_end    TIMESTAMPTZ,
  next_charge_at        TIMESTAMPTZ,
  cancel_at_period_end  BOOLEAN NOT NULL DEFAULT FALSE,
  cancelled_at          TIMESTAMPTZ,
  pause_until           TIMESTAMPTZ,
  payment_ref           TEXT,
  provider              TEXT,
  failed_attempts       INTEGER NOT NULL DEFAULT 0,
  last_failure_at       TIMESTAMPTZ,
  last_invoice_id       TEXT,
  pending_adjustment_minor BIGINT NOT NULL DEFAULT 0,
  trial_reminder_at     TIMESTAMPTZ,
  join_token_hash       TEXT,
  created_at            TIMESTAMPTZ DEFAULT NOW(),
  updated_at            TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX ASYNC IF NOT EXISTS idx_customer_subs_user_status ON customer_subscriptions (user_id, status);
CREATE INDEX ASYNC IF NOT EXISTS idx_customer_subs_contact ON customer_subscriptions (user_id, contact_id);
CREATE INDEX ASYNC IF NOT EXISTS idx_customer_subs_plan ON customer_subscriptions (plan_id);
CREATE INDEX ASYNC IF NOT EXISTS idx_customer_subs_due ON customer_subscriptions (next_charge_at);

CREATE TABLE IF NOT EXISTS subscription_charges (
  id               TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL,
  subscription_id  TEXT NOT NULL,
  invoice_id       TEXT,
  period_start     TIMESTAMPTZ NOT NULL,
  period_end       TIMESTAMPTZ NOT NULL,
  amount_minor     BIGINT NOT NULL DEFAULT 0,
  currency         TEXT NOT NULL DEFAULT 'USD',
  status           TEXT NOT NULL DEFAULT 'pending',    -- pending|paid|failed|void
  attempt          INTEGER NOT NULL DEFAULT 0,
  provider_ref     TEXT,
  error            TEXT,
  created_at       TIMESTAMPTZ DEFAULT NOW()
);
CREATE UNIQUE INDEX ASYNC IF NOT EXISTS uq_subscription_charges_period ON subscription_charges (subscription_id, period_start);
CREATE INDEX ASYNC IF NOT EXISTS idx_subscription_charges_invoice ON subscription_charges (invoice_id);
CREATE INDEX ASYNC IF NOT EXISTS idx_subscription_charges_user ON subscription_charges (user_id, created_at);
