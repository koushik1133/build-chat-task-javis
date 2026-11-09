import { query, queryOne } from "@/lib/dsql";
import { getBalance, InsufficientCreditsError } from "@/lib/credits/ledger";

/**
 * Per-user AI spend caps and model governance.
 *
 * `assertBudget` is called before EVERY model call the runtime makes, so a
 * runaway agent stops at the cap rather than at the invoice. When credits are
 * enforced (`ai_budgets.credits_enforced`) it also refuses to start a call on
 * an exhausted credit balance.
 */

export class LlmBudgetExceededError extends Error {
  constructor(
    public readonly spentMicros: number,
    public readonly capMicros: number,
    /** Which cap tripped: the monthly total, the daily total, or one feature's monthly cap. */
    public readonly cap: "monthly" | "daily" | "feature" = "monthly",
    public readonly feature?: string
  ) {
    super(
      cap === "daily"
        ? `AI daily cap reached: ${(spentMicros / 1e6).toFixed(2)} of ${(capMicros / 1e6).toFixed(2)} USD used today.`
        : cap === "feature"
          ? `AI cap for "${feature}" reached: ${(spentMicros / 1e6).toFixed(2)} of ${(capMicros / 1e6).toFixed(2)} USD used this month.`
          : `AI budget exhausted: ${(spentMicros / 1e6).toFixed(2)} of ${(capMicros / 1e6).toFixed(2)} USD used this month.`
    );
    this.name = "LlmBudgetExceededError";
  }
}

export interface BudgetRow {
  user_id: string;
  monthly_cap_micros: string | number | null;
  hard_stop: boolean | null;
  model_allowlist: string | null;
  credits_enforced?: boolean | null;
  feature_caps?: string | null;
  daily_cap_micros?: string | number | null;
  max_tokens_per_call?: number | string | null;
  fallback_model?: string | null;
}

export interface BudgetView {
  capMicros: number | null;
  hardStop: boolean;
  allowlist: string[] | null;
  spentMicros: number;
  /** Stop model calls once the credit balance is exhausted. */
  creditsEnforced: boolean;
  /** Monthly cap per feature (micros), e.g. { receptionist: 5_000_000 }. */
  featureCaps: Record<string, number>;
  dailyCapMicros: number | null;
  spentTodayMicros: number;
  /** Month-to-date spend by feature (micros). */
  spentByFeature: Record<string, number>;
  maxTokensPerCall: number | null;
  /** Cheaper model used for low-risk features when set. */
  fallbackModel: string | null;
}

function dayStart(): string {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString();
}

export function parseFeatureCaps(raw: string | null | undefined): Record<string, number> {
  if (!raw) return {};
  try {
    const v: unknown = JSON.parse(raw);
    if (!v || typeof v !== "object" || Array.isArray(v)) return {};
    const out: Record<string, number> = {};
    for (const [k, n] of Object.entries(v as Record<string, unknown>)) {
      const num = Number(n);
      if (Number.isFinite(num) && num >= 0) out[k] = Math.round(num);
    }
    return out;
  } catch {
    return {};
  }
}

function monthStart(): string {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString();
}

export async function getBudget(userId: string): Promise<BudgetView> {
  // SELECT * so a deployment that has not run the credits migration yet still reads its cap.
  const row = await queryOne<BudgetRow>(`SELECT * FROM ai_budgets WHERE user_id = $1`, [userId]).catch(() => null);

  const spent = await queryOne<{ total: string | number | null }>(
    `SELECT COALESCE(SUM(cost_micros), 0) AS total FROM ai_usage WHERE user_id = $1 AND created_at >= $2`,
    [userId, monthStart()]
  ).catch(() => null);

  const [today, byFeature] = await Promise.all([
    Promise.resolve(
      queryOne<{ total: string | number | null }>(
        `SELECT COALESCE(SUM(cost_micros), 0) AS total FROM ai_usage WHERE user_id = $1 AND created_at >= $2`,
        [userId, dayStart()]
      )
    ).catch(() => null),
    Promise.resolve(
      query<{ feature: string; total: string | number | null }>(
        `SELECT feature, COALESCE(SUM(cost_micros), 0) AS total FROM ai_usage WHERE user_id = $1 AND created_at >= $2 GROUP BY feature`,
        [userId, monthStart()]
      )
    ).catch(() => [] as { feature: string; total: string | number | null }[]),
  ]);
  const spentByFeature: Record<string, number> = {};
  for (const r of byFeature ?? []) spentByFeature[r.feature] = Number(r.total ?? 0) || 0;

  let allowlist: string[] | null = null;
  if (row?.model_allowlist) {
    try {
      const parsed = JSON.parse(row.model_allowlist);
      if (Array.isArray(parsed)) allowlist = parsed.map(String);
    } catch {
      allowlist = null;
    }
  }

  return {
    capMicros: row?.monthly_cap_micros == null ? null : Number(row.monthly_cap_micros),
    hardStop: row?.hard_stop !== false,
    allowlist,
    spentMicros: Number(spent?.total ?? 0) || 0,
    creditsEnforced: row?.credits_enforced === true,
    featureCaps: parseFeatureCaps(row?.feature_caps),
    dailyCapMicros: row?.daily_cap_micros == null ? null : Number(row.daily_cap_micros),
    spentTodayMicros: Number(today?.total ?? 0) || 0,
    spentByFeature,
    maxTokensPerCall: row?.max_tokens_per_call == null ? null : Number(row.max_tokens_per_call),
    fallbackModel: row?.fallback_model?.trim() || null,
  };
}

/**
 * Throws LlmBudgetExceededError when a hard cap is reached, and
 * InsufficientCreditsError when credits are enforced and the balance is gone.
 */
export async function assertBudget(userId: string, feature?: string): Promise<BudgetView> {
  const b = await getBudget(userId);
  checkBudgetView(b, feature);
  if (b.creditsEnforced) {
    // A ledger outage must not take every model call down: only a readable, exhausted balance blocks.
    const balance = await getBalance(userId).catch(() => null);
    if (balance !== null && balance <= 0) throw new InsufficientCreditsError(balance);
  }
  return b;
}

/** Pure cap check (exported for tests). Throws LlmBudgetExceededError naming the tripped cap. */
export function checkBudgetView(b: BudgetView, feature?: string): void {
  if (b.capMicros != null && b.hardStop && b.spentMicros >= b.capMicros) {
    throw new LlmBudgetExceededError(b.spentMicros, b.capMicros, "monthly");
  }
  if (b.dailyCapMicros != null && b.hardStop && b.spentTodayMicros >= b.dailyCapMicros) {
    throw new LlmBudgetExceededError(b.spentTodayMicros, b.dailyCapMicros, "daily");
  }
  if (feature && b.featureCaps[feature] != null) {
    const spent = b.spentByFeature[feature] ?? 0;
    if (spent >= b.featureCaps[feature]) throw new LlmBudgetExceededError(spent, b.featureCaps[feature], "feature", feature);
  }
}

export interface BudgetPatch {
  capMicros?: number | null;
  hardStop?: boolean;
  allowlist?: string[] | null;
  creditsEnforced?: boolean;
  featureCaps?: Record<string, number> | null;
  dailyCapMicros?: number | null;
  maxTokensPerCall?: number | null;
  fallbackModel?: string | null;
}

export async function setBudget(
  userId: string,
  patch: BudgetPatch
): Promise<void> {
  const existing = await queryOne<BudgetRow>(`SELECT * FROM ai_budgets WHERE user_id = $1`, [userId]).catch(() => null);
  const cap = patch.capMicros !== undefined ? patch.capMicros : existing?.monthly_cap_micros ?? null;
  const hard = patch.hardStop !== undefined ? patch.hardStop : existing?.hard_stop ?? true;
  const allow =
    patch.allowlist !== undefined
      ? patch.allowlist === null ? null : JSON.stringify(patch.allowlist)
      : existing?.model_allowlist ?? null;

  if (existing) {
    await query(
      `UPDATE ai_budgets SET monthly_cap_micros = $2, hard_stop = $3, model_allowlist = $4, updated_at = NOW() WHERE user_id = $1`,
      [userId, cap, hard, allow]
    );
  } else {
    await query(
      `INSERT INTO ai_budgets (user_id, monthly_cap_micros, hard_stop, model_allowlist) VALUES ($1, $2, $3, $4)`,
      [userId, cap, hard, allow]
    );
  }
  // Own statement so a deployment without the credits column still saves the rest.
  if (patch.creditsEnforced !== undefined) {
    await query(`UPDATE ai_budgets SET credits_enforced = $2, updated_at = NOW() WHERE user_id = $1`, [userId, patch.creditsEnforced]);
  }

  // Phase 9 limits live in their own statement so a deployment without the columns still saves the rest.
  const hasLimits =
    patch.featureCaps !== undefined || patch.dailyCapMicros !== undefined || patch.maxTokensPerCall !== undefined || patch.fallbackModel !== undefined;
  if (hasLimits) {
    const cur = await queryOne<BudgetRow>(`SELECT * FROM ai_budgets WHERE user_id = $1`, [userId]);
    const caps = patch.featureCaps !== undefined ? (patch.featureCaps === null ? null : JSON.stringify(patch.featureCaps)) : cur?.feature_caps ?? null;
    const daily = patch.dailyCapMicros !== undefined ? patch.dailyCapMicros : cur?.daily_cap_micros ?? null;
    const maxTok = patch.maxTokensPerCall !== undefined ? patch.maxTokensPerCall : cur?.max_tokens_per_call ?? null;
    const fb = patch.fallbackModel !== undefined ? patch.fallbackModel : cur?.fallback_model ?? null;
    await query(
      `UPDATE ai_budgets SET feature_caps = $2, daily_cap_micros = $3, max_tokens_per_call = $4, fallback_model = $5, updated_at = NOW() WHERE user_id = $1`,
      [userId, caps, daily, maxTok, fb]
    );
  }
}
