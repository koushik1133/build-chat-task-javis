-- Phase 10 lane B: KernelHub subscription plans, entitlements, seats, usage.

CREATE TABLE IF NOT EXISTS subscriptions (
  user_id                   TEXT PRIMARY KEY,                 -- org data id
  plan_key                  TEXT NOT NULL,                    -- free|starter|growth|scale|enterprise
  status                    TEXT NOT NULL DEFAULT 'trialing', -- trialing|active|past_due|cancelled|paused
  billing_interval          TEXT NOT NULL DEFAULT 'month',    -- month|year
  currency                  TEXT NOT NULL DEFAULT 'USD',
  seats_purchased           INTEGER NOT NULL DEFAULT 1,
  trial_ends_at             TIMESTAMPTZ,
  current_period_start      TIMESTAMPTZ,
  current_period_end        TIMESTAMPTZ,
  cancel_at_period_end      BOOLEAN NOT NULL DEFAULT FALSE,
  provider                  TEXT,
  provider_customer_ref     TEXT,
  provider_subscription_ref TEXT,
  pending_plan_key          TEXT,                             -- scheduled downgrade, applied at renewal
  pending_interval          TEXT,
  pending_seats             INTEGER,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX ASYNC IF NOT EXISTS idx_subscriptions_due ON subscriptions (status, current_period_end);

CREATE TABLE IF NOT EXISTS plan_invoices (
  id               TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL,
  subscription_id  TEXT NOT NULL,                             -- = subscriptions.user_id
  kind             TEXT NOT NULL DEFAULT 'subscribe',         -- subscribe|upgrade|seats|renewal
  plan_key         TEXT NOT NULL,
  billing_interval TEXT NOT NULL DEFAULT 'month',
  seats            INTEGER NOT NULL DEFAULT 1,
  period_start     TIMESTAMPTZ,
  period_end       TIMESTAMPTZ,
  amount_minor     BIGINT NOT NULL DEFAULT 0,
  currency         TEXT NOT NULL DEFAULT 'USD',
  status           TEXT NOT NULL DEFAULT 'open',              -- open|paid|void|failed
  provider         TEXT,
  provider_ref     TEXT,
  token_hash       TEXT,
  paid_at          TIMESTAMPTZ,
  pdf_hash         TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX ASYNC IF NOT EXISTS idx_plan_invoices_user ON plan_invoices (user_id, created_at);

CREATE INDEX ASYNC IF NOT EXISTS idx_plan_invoices_token ON plan_invoices (token_hash);

CREATE TABLE IF NOT EXISTS usage_counters (
  user_id      TEXT NOT NULL,
  metric       TEXT NOT NULL,
  period_start DATE NOT NULL,
  value        BIGINT NOT NULL DEFAULT 0,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, metric, period_start)
);

CREATE TABLE IF NOT EXISTS plan_overrides (
  user_id      TEXT PRIMARY KEY,
  entitlements TEXT NOT NULL DEFAULT '{}',                    -- JSON {plan_key?, limits?, features?}
  reason       TEXT,
  created_by   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
