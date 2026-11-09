-- Phase 11 / Lane E: customer engagement (surveys, reviews, loyalty, gift cards, vouchers, referrals).
-- DSQL rules: no FKs/triggers, JSON as TEXT, CREATE INDEX ASYNC, one statement per block.

CREATE TABLE IF NOT EXISTS surveys (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  questions TEXT NOT NULL,
  trigger_event TEXT,
  delay_hours INTEGER NOT NULL,
  channel TEXT NOT NULL,
  active BOOLEAN NOT NULL,
  thank_you_md TEXT,
  public_review_prompt BOOLEAN NOT NULL,
  review_url TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX ASYNC IF NOT EXISTS idx_surveys_user ON surveys (user_id, active);

CREATE TABLE IF NOT EXISTS survey_requests (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  survey_id TEXT NOT NULL,
  contact_id TEXT,
  entity_kind TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  send_after TIMESTAMPTZ,
  sent_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX ASYNC IF NOT EXISTS uq_survey_requests_entity ON survey_requests (survey_id, entity_kind, entity_id);

CREATE INDEX ASYNC IF NOT EXISTS idx_survey_requests_due ON survey_requests (status, send_after);

CREATE INDEX ASYNC IF NOT EXISTS idx_survey_requests_user ON survey_requests (user_id, created_at);

CREATE TABLE IF NOT EXISTS survey_responses (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  survey_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  contact_id TEXT,
  score INTEGER,
  answers TEXT NOT NULL,
  comment TEXT,
  public BOOLEAN NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX ASYNC IF NOT EXISTS uq_survey_responses_request ON survey_responses (request_id);

CREATE INDEX ASYNC IF NOT EXISTS idx_survey_responses_user ON survey_responses (user_id, created_at);

CREATE INDEX ASYNC IF NOT EXISTS idx_survey_responses_survey ON survey_responses (survey_id, created_at);

CREATE TABLE IF NOT EXISTS testimonials (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  response_id TEXT NOT NULL,
  quote TEXT NOT NULL,
  author_name TEXT NOT NULL,
  rating INTEGER,
  featured BOOLEAN NOT NULL,
  published BOOLEAN NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX ASYNC IF NOT EXISTS uq_testimonials_response ON testimonials (user_id, response_id);

CREATE INDEX ASYNC IF NOT EXISTS idx_testimonials_user ON testimonials (user_id, published, created_at);

CREATE TABLE IF NOT EXISTS engagement_cursors (
  name TEXT PRIMARY KEY,
  last_event_at TIMESTAMPTZ,
  last_event_id TEXT,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS loyalty_programs (
  user_id TEXT PRIMARY KEY,
  enabled BOOLEAN NOT NULL,
  earn_points INTEGER NOT NULL,
  per_minor INTEGER NOT NULL,
  redeem_value_minor_per_point INTEGER NOT NULL,
  tiers TEXT NOT NULL,
  expiry_months INTEGER,
  min_redeem_points INTEGER NOT NULL,
  max_redeem_pct_bp INTEGER NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS loyalty_accounts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  contact_id TEXT NOT NULL,
  balance BIGINT NOT NULL,
  lifetime_points BIGINT NOT NULL,
  tier TEXT,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX ASYNC IF NOT EXISTS uq_loyalty_accounts_contact ON loyalty_accounts (user_id, contact_id);

CREATE TABLE IF NOT EXISTS loyalty_ledger (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  points BIGINT NOT NULL,
  balance_after BIGINT NOT NULL,
  ref_kind TEXT,
  ref_id TEXT,
  note TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX ASYNC IF NOT EXISTS uq_loyalty_ledger_ref ON loyalty_ledger (user_id, kind, ref_kind, ref_id);

CREATE INDEX ASYNC IF NOT EXISTS idx_loyalty_ledger_account ON loyalty_ledger (account_id, created_at);

CREATE TABLE IF NOT EXISTS gift_cards (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  code_last4 TEXT NOT NULL,
  initial_minor BIGINT NOT NULL,
  balance_minor BIGINT NOT NULL,
  currency TEXT NOT NULL,
  status TEXT NOT NULL,
  purchaser_contact_id TEXT,
  recipient_email TEXT,
  message TEXT,
  expires_at TIMESTAMPTZ,
  issued_via TEXT NOT NULL,
  order_id TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX ASYNC IF NOT EXISTS uq_gift_cards_code ON gift_cards (user_id, code_hash);

CREATE INDEX ASYNC IF NOT EXISTS idx_gift_cards_user ON gift_cards (user_id, created_at);

CREATE TABLE IF NOT EXISTS gift_card_ledger (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  gift_card_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  amount_minor BIGINT NOT NULL,
  balance_after BIGINT NOT NULL,
  ref_kind TEXT,
  ref_id TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX ASYNC IF NOT EXISTS uq_gift_card_ledger_ref ON gift_card_ledger (user_id, kind, ref_kind, ref_id);

CREATE INDEX ASYNC IF NOT EXISTS idx_gift_card_ledger_card ON gift_card_ledger (gift_card_id, created_at);

CREATE TABLE IF NOT EXISTS vouchers (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  code_upper TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  value INTEGER NOT NULL,
  currency TEXT,
  min_subtotal_minor BIGINT NOT NULL,
  max_uses INTEGER,
  per_contact_limit INTEGER,
  used_count INTEGER NOT NULL,
  starts_at TIMESTAMPTZ,
  ends_at TIMESTAMPTZ,
  applies_to TEXT NOT NULL,
  applies_config TEXT,
  stackable BOOLEAN NOT NULL,
  active BOOLEAN NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX ASYNC IF NOT EXISTS uq_vouchers_code ON vouchers (user_id, code_upper);

CREATE TABLE IF NOT EXISTS voucher_redemptions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  voucher_id TEXT NOT NULL,
  contact_id TEXT,
  entity_kind TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  amount_minor BIGINT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX ASYNC IF NOT EXISTS uq_voucher_redemptions_entity ON voucher_redemptions (voucher_id, entity_kind, entity_id);

CREATE INDEX ASYNC IF NOT EXISTS idx_voucher_redemptions_contact ON voucher_redemptions (voucher_id, contact_id);

CREATE TABLE IF NOT EXISTS referral_codes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  contact_id TEXT NOT NULL,
  code TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX ASYNC IF NOT EXISTS uq_referral_codes_code ON referral_codes (user_id, code);

CREATE UNIQUE INDEX ASYNC IF NOT EXISTS uq_referral_codes_contact ON referral_codes (user_id, contact_id);

CREATE TABLE IF NOT EXISTS referrals (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  referrer_contact_id TEXT NOT NULL,
  code TEXT NOT NULL,
  referee_contact_id TEXT,
  status TEXT NOT NULL,
  reward_points INTEGER NOT NULL,
  reward_voucher_id TEXT,
  qualified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX ASYNC IF NOT EXISTS uq_referrals_referee ON referrals (user_id, referee_contact_id);

CREATE INDEX ASYNC IF NOT EXISTS idx_referrals_referrer ON referrals (user_id, referrer_contact_id, created_at);

ALTER TABLE products ADD COLUMN IF NOT EXISTS is_gift_card BOOLEAN;
