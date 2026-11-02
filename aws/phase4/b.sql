-- ── Phase 4 / Lane B: AI credits, outcome pricing, eval harness, corrections-as-memory ──
-- DSQL dialect: TEXT ids, no FKs, CREATE INDEX ASYNC, no partial indexes.

-- ── Credits ──────────────────────────────────────────────────────────────────

-- One row per user; `balance` is the single source of truth for the current
-- balance. Writers update it with `WHERE balance = <expected>` (optimistic
-- concurrency) and only then append the ledger row, so two parallel charges
-- can never both read the same starting balance and both win.
CREATE TABLE IF NOT EXISTS ai_credit_accounts (
  user_id     TEXT PRIMARY KEY,
  balance     BIGINT NOT NULL DEFAULT 0,          -- credits; 1 credit = 1/1000 USD
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Append-only ledger. `credits` is signed (purchases/grants positive, usage/
-- outcome negative); `balance_after` is the account balance once this row
-- was applied, so the history is auditable without replaying it.
CREATE TABLE IF NOT EXISTS ai_credit_ledger (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL,
  kind           TEXT NOT NULL,                    -- purchase|grant|usage|outcome|refund|adjustment
  credits        BIGINT NOT NULL,
  balance_after  BIGINT NOT NULL,
  ref_kind       TEXT,                             -- usage|run|purchase|signup|manual
  ref_id         TEXT,
  note           TEXT,
  created_at     TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX ASYNC IF NOT EXISTS idx_ai_credit_ledger_user ON ai_credit_ledger (user_id, created_at);
-- Idempotency: one ledger row per (kind, ref). Outcome charges key on the run
-- id, purchases on the purchase id, the free grant on the user id.
CREATE UNIQUE INDEX ASYNC IF NOT EXISTS idx_ai_credit_ledger_ref ON ai_credit_ledger (user_id, kind, ref_kind, ref_id);

-- Credit pack purchases. The pack catalog itself lives in code
-- (src/lib/credits/packs.ts). `token_hash` is the sha256 of the public
-- checkout token used by /p/credits/<token>, mirroring share_tokens.
CREATE TABLE IF NOT EXISTS ai_credit_purchases (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL,
  pack_id       TEXT NOT NULL,
  credits       BIGINT NOT NULL,
  amount_minor  BIGINT NOT NULL,
  currency      TEXT NOT NULL DEFAULT 'USD',
  provider      TEXT NOT NULL,                     -- simulated|stripe|razorpay
  provider_ref  TEXT,
  status        TEXT NOT NULL DEFAULT 'pending',   -- pending|paid|failed
  token_hash    TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  paid_at       TIMESTAMPTZ
);
CREATE INDEX ASYNC IF NOT EXISTS idx_ai_credit_purchases_user ON ai_credit_purchases (user_id, created_at);
CREATE INDEX ASYNC IF NOT EXISTS idx_ai_credit_purchases_ref ON ai_credit_purchases (provider, provider_ref);
CREATE UNIQUE INDEX ASYNC IF NOT EXISTS idx_ai_credit_purchases_token ON ai_credit_purchases (token_hash);

-- Enforcement toggle: when on, model calls stop once the balance is exhausted.
ALTER TABLE ai_budgets ADD COLUMN IF NOT EXISTS credits_enforced BOOLEAN DEFAULT FALSE;

-- Outcome pricing: charge `outcome_price_credits` once per run that ends with
-- `outcome_event` (an events-bus type such as booking.created) having fired.
ALTER TABLE agents ADD COLUMN IF NOT EXISTS outcome_event TEXT;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS outcome_price_credits BIGINT;

-- ── Evaluation harness ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS agent_evals (
  id          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id     TEXT NOT NULL,
  agent_id    TEXT NOT NULL,                       -- agents.id (uuid as text)
  name        TEXT NOT NULL,
  cases       TEXT NOT NULL DEFAULT '[]',          -- JSON [{ input, expected, rubric }]
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX ASYNC IF NOT EXISTS idx_agent_evals_agent ON agent_evals (user_id, agent_id, created_at);

CREATE TABLE IF NOT EXISTS agent_eval_runs (
  id           TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id      TEXT NOT NULL,
  eval_id      TEXT NOT NULL,
  agent_id     TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'queued',     -- queued|running|done|failed
  score        INTEGER,                            -- 0..100 mean across cases
  results      TEXT,                               -- JSON [{ idx, input, expected, output, score, reasons, transcript, cost_micros }]
  model        TEXT,
  cost_micros  BIGINT DEFAULT 0,
  error        TEXT,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  finished_at  TIMESTAMPTZ
);
CREATE INDEX ASYNC IF NOT EXISTS idx_agent_eval_runs_eval ON agent_eval_runs (user_id, eval_id, created_at);

-- ── Corrections-as-memory ────────────────────────────────────────────────────
-- `agent_corrections` already exists (original_text / corrected_text / context);
-- extend it with provenance and the vector reference.
ALTER TABLE agent_corrections ADD COLUMN IF NOT EXISTS run_id TEXT;
ALTER TABLE agent_corrections ADD COLUMN IF NOT EXISTS step_id TEXT;
ALTER TABLE agent_corrections ADD COLUMN IF NOT EXISTS note TEXT;
ALTER TABLE agent_corrections ADD COLUMN IF NOT EXISTS embedding_ref TEXT;   -- pinecone file id: corr:<id>
