-- Phase 9 lane E: AI cost controls (per-feature caps, daily cap, token ceiling, fallback model)
ALTER TABLE ai_budgets ADD COLUMN IF NOT EXISTS feature_caps TEXT;
ALTER TABLE ai_budgets ADD COLUMN IF NOT EXISTS daily_cap_micros BIGINT;
ALTER TABLE ai_budgets ADD COLUMN IF NOT EXISTS max_tokens_per_call INTEGER;
ALTER TABLE ai_budgets ADD COLUMN IF NOT EXISTS fallback_model TEXT;
