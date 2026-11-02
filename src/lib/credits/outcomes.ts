import { queryOne } from "@/lib/dsql";
import { chargeOutcome } from "./ledger";

/**
 * Outcome pricing: an agent may declare `outcome_event` (an events-bus type,
 * e.g. booking.created) and `outcome_price_credits`. When a run finishes and
 * that event fired for the tenant during the run, the price is charged once.
 *
 * Hook: `settleRunOutcome(run)` is called from `finalize()` in
 * src/lib/agents/runner.ts when a run ends with status "done".
 */
export interface OutcomeSettlement {
  charged: boolean;
  outcome: string | null;
  credits: number;
}

export async function settleRunOutcome(run: { id: string; user_id: string; agent_id: string }): Promise<OutcomeSettlement> {
  const none: OutcomeSettlement = { charged: false, outcome: null, credits: 0 };

  const agent = await queryOne<{ outcome_event: string | null; outcome_price_credits: string | number | null }>(
    `SELECT outcome_event, outcome_price_credits FROM agents WHERE id = $1 AND user_id = $2`,
    [run.agent_id, run.user_id]
  ).catch(() => null); // columns missing pre-migration → no outcome pricing
  const outcome = agent?.outcome_event?.trim() || null;
  const price = Math.trunc(Number(agent?.outcome_price_credits ?? 0));
  if (!outcome || !(price > 0)) return none;

  const window = await queryOne<{ since: string | null }>(
    `SELECT COALESCE(started_at, created_at)::text AS since FROM agent_runs WHERE id = $1`,
    [run.id]
  ).catch(() => null);
  if (!window?.since) return none;

  const fired = await queryOne<{ id: string }>(
    `SELECT id FROM events WHERE user_id = $1 AND type = $2 AND created_at >= $3 ORDER BY created_at DESC LIMIT 1`,
    [run.user_id, outcome, window.since]
  ).catch(() => null);
  if (!fired) return { ...none, outcome };

  const res = await chargeOutcome(run.user_id, { agentId: run.agent_id, runId: run.id, outcome, credits: price });
  return { charged: res.charged, outcome, credits: price };
}
