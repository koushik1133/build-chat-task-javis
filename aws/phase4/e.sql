-- ==== PHASE 4 LANE E: agency mode, SCIM 2.0 / SSO readiness, optimization AI ====
-- DSQL rules: no FKs, JSON stored as TEXT, CREATE INDEX ASYNC, one DDL per statement.

-- ── organizations: agency hierarchy ─────────────────────────────────────────
-- kind: standard | agency | client. A client org is owned by an agency org
-- (parent_org_id) and its owner_user_id is a synthetic data id equal to the
-- client org's own id (see src/lib/agency/orgs.ts). archived_at soft-deletes.
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS parent_org_id TEXT;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS kind TEXT DEFAULT 'standard';
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;
CREATE INDEX ASYNC IF NOT EXISTS idx_organizations_parent ON organizations (parent_org_id);

-- ── scim_tokens: bearer tokens for the SCIM 2.0 provisioning endpoint ───────
-- user_id is the org data id (organizations.owner_user_id). Only the SHA-256
-- of the token is stored; the plaintext is shown once at creation.
CREATE TABLE IF NOT EXISTS scim_tokens (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  name         TEXT NOT NULL,
  token_hash   TEXT NOT NULL,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  last_used_at TIMESTAMPTZ,
  revoked_at   TIMESTAMPTZ
);
CREATE UNIQUE INDEX ASYNC IF NOT EXISTS idx_scim_tokens_hash ON scim_tokens (token_hash);
CREATE INDEX ASYNC IF NOT EXISTS idx_scim_tokens_user ON scim_tokens (user_id, revoked_at);

-- ── sso_domains: email domain → Supabase SAML provider id ───────────────────
CREATE TABLE IF NOT EXISTS sso_domains (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  domain      TEXT NOT NULL,
  provider_id TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE UNIQUE INDEX ASYNC IF NOT EXISTS idx_sso_domains_domain ON sso_domains (domain);
CREATE INDEX ASYNC IF NOT EXISTS idx_sso_domains_user ON sso_domains (user_id);
