-- ── Phase 3 / Lane E: white-label org branding ──────────────────────────────
-- One row per org, keyed by the org's data id (owner_user_id) like every other
-- module table. Org locale / currency / timezone live in organizations.settings
-- (JSON TEXT) and need no migration.

CREATE TABLE IF NOT EXISTS org_branding (
  user_id        TEXT PRIMARY KEY,
  brand_name     TEXT,
  logo_url       TEXT,
  primary_color  TEXT,                 -- #rrggbb
  accent_color   TEXT,                 -- #rrggbb
  email_footer   TEXT,
  custom_domain  TEXT,
  support_email  TEXT,
  favicon_url    TEXT,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
