-- Phase 5 / Lane A: platform hardening
-- DSQL rules: no FKs, no triggers, JSON as TEXT, CREATE INDEX ASYNC, one statement per block, no DEFAULT on ADD COLUMN.

-- Shared fixed-window rate limiter (RATE_LIMIT_STORE=db). Pruned by pruneRateLimits().
CREATE TABLE IF NOT EXISTS rate_limits (
  key          TEXT PRIMARY KEY,
  count        INTEGER NOT NULL DEFAULT 0,
  window_start TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX ASYNC IF NOT EXISTS idx_rate_limits_updated ON rate_limits (updated_at);

-- Quote OTP challenges now carry a purpose (accept | decline) so codes are not interchangeable.
ALTER TABLE quote_acceptances ADD COLUMN IF NOT EXISTS purpose TEXT;

-- SSO domain DNS verification (TXT record _kernelhub-verification.<domain> or apex).
ALTER TABLE sso_domains ADD COLUMN IF NOT EXISTS verification_token TEXT;

ALTER TABLE sso_domains ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ;

ALTER TABLE sso_domains ADD COLUMN IF NOT EXISTS last_verify_error TEXT;

-- Deduplicated application errors (fingerprint = sha1(route + first line of message)).
CREATE TABLE IF NOT EXISTS app_errors (
  id          TEXT PRIMARY KEY,
  user_id     TEXT,
  route       TEXT NOT NULL,
  method      TEXT,
  status      INTEGER,
  message     TEXT NOT NULL,
  stack       TEXT,
  fingerprint TEXT NOT NULL,
  count       INTEGER NOT NULL DEFAULT 1,
  first_seen  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX ASYNC IF NOT EXISTS idx_app_errors_fingerprint ON app_errors (fingerprint);

CREATE INDEX ASYNC IF NOT EXISTS idx_app_errors_last_seen ON app_errors (last_seen);

-- Small key/value state for the system health page (cron last tick etc.). `value` is JSON TEXT.
CREATE TABLE IF NOT EXISTS system_state (
  key        TEXT PRIMARY KEY,
  value      TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
