-- Phase 7 / Lane E: attachments on any entity, document templates, generic e-sign documents + signers.
-- DSQL rules: no FKs, no triggers, JSON as TEXT, CREATE INDEX ASYNC, one statement per block, no DEFAULT on ADD COLUMN.

-- ── attachments: files attached to any entity (private storage; soft delete) ──
CREATE TABLE IF NOT EXISTS attachments (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL,
  entity_kind   TEXT NOT NULL,              -- contact|lead|quote|invoice|ticket|record|booking|task|product|purchase_order|document
  entity_id     TEXT NOT NULL,
  file_name     TEXT NOT NULL,
  content_type  TEXT NOT NULL,
  size_bytes    BIGINT NOT NULL DEFAULT 0,
  storage_path  TEXT NOT NULL,
  sha256        TEXT NOT NULL,
  uploaded_by   TEXT,
  visibility    TEXT NOT NULL DEFAULT 'internal', -- internal|portal
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at    TIMESTAMPTZ
);

CREATE INDEX ASYNC IF NOT EXISTS idx_attachments_entity ON attachments (user_id, entity_kind, entity_id, created_at);

-- ── document_templates: markdown bodies with {{merge.fields}} ──
CREATE TABLE IF NOT EXISTS document_templates (
  id                 TEXT PRIMARY KEY,
  user_id            TEXT NOT NULL,
  name               TEXT NOT NULL,
  kind               TEXT NOT NULL DEFAULT 'other', -- contract|proposal|nda|letter|form|other
  body_md            TEXT NOT NULL DEFAULT '',
  fields             TEXT,                           -- JSON [{key,label,source}]
  requires_signature BOOLEAN NOT NULL DEFAULT TRUE,
  signer_roles       TEXT,                           -- JSON ["client","company"]
  version            INTEGER NOT NULL DEFAULT 1,
  starter_slug       TEXT,                           -- set when installed from a built-in starter
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX ASYNC IF NOT EXISTS idx_document_templates_user ON document_templates (user_id, created_at);

-- ── documents: rendered instances sent for signature ──
CREATE TABLE IF NOT EXISTS documents (
  id               TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL,
  template_id      TEXT,
  title            TEXT NOT NULL,
  kind             TEXT NOT NULL DEFAULT 'other',
  body_md          TEXT NOT NULL DEFAULT '',
  merge_data       TEXT,                             -- JSON
  status           TEXT NOT NULL DEFAULT 'draft',    -- draft|sent|viewed|signed|declined|expired|void
  signing_order    TEXT NOT NULL DEFAULT 'parallel', -- sequential|parallel
  contact_id       TEXT,
  record_id        TEXT,
  quote_id         TEXT,
  pdf_hash         TEXT,
  signed_pdf_hash  TEXT,
  sent_at          TIMESTAMPTZ,
  viewed_at        TIMESTAMPTZ,
  completed_at     TIMESTAMPTZ,
  expires_at       TIMESTAMPTZ,
  created_by       TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX ASYNC IF NOT EXISTS idx_documents_user_status ON documents (user_id, status, created_at);

CREATE INDEX ASYNC IF NOT EXISTS idx_documents_contact ON documents (user_id, contact_id);

CREATE INDEX ASYNC IF NOT EXISTS idx_documents_expiry ON documents (status, expires_at);

-- ── document_signers: one row per signer; OTP challenge + consent snapshot ──
CREATE TABLE IF NOT EXISTS document_signers (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL,
  document_id     TEXT NOT NULL,
  name            TEXT NOT NULL,
  email           TEXT NOT NULL,
  role            TEXT,
  order_index     INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'pending', -- pending|viewed|signed|declined
  signed_at       TIMESTAMPTZ,
  signature_text  TEXT,
  ip              TEXT,
  user_agent      TEXT,
  consent_text    TEXT,
  otp_hash        TEXT,
  otp_expires_at  TIMESTAMPTZ,
  otp_attempts    INTEGER NOT NULL DEFAULT 0,
  share_token_id  TEXT,
  decline_reason  TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX ASYNC IF NOT EXISTS idx_document_signers_doc ON document_signers (document_id, order_index);

CREATE INDEX ASYNC IF NOT EXISTS idx_document_signers_user ON document_signers (user_id, email);
