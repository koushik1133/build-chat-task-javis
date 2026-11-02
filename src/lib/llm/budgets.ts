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
  constructor(public readonly spentMicros: number, public readonly capMicros: number) {
    super(
      `AI budget exhausted: ${(spentMicros / 1e6).toFixed(2)} of ${(capMicros / 1e6).toFixed(2)} USD used this month.`
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
}

export interface BudgetView {
  capMicros: number | null;
  hardStop: boolean;
  allowlist: string[] | null;
  spentMicros: number;
  /** Stop model calls once the credit balance is exhausted. */
  creditsEnforced: boolean;
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
  };
}

/**
 * Throws LlmBudgetExceededError when a hard cap is reached, and
 * InsufficientCreditsError when credits are enforced and the balance is gone.
 */
export async function assertBudget(userId: string): Promise<BudgetView> {
  const b = await getBudget(userId);
  if (b.capMicros != null && b.hardStop && b.spentMicros >= b.capMicros) {
    throw new LlmBudgetExceededError(b.spentMicros, b.capMicros);
  }
  if (b.creditsEnforced) {
    // A ledger outage must not take every model call down: only a readable, exhausted balance blocks.
    const balance = await getBalance(userId).catch(() => null);
    if (balance !== null && balance <= 0) throw new InsufficientCreditsError(balance);
  }
  return b;
}

export async function setBudget(
  userId: string,
  patch: { capMicros?: number | null; hardStop?: boolean; allowlist?: string[] | null; creditsEnforced?: boolean }
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
}
