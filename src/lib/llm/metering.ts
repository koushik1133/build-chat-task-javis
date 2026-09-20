import { randomUUID } from "crypto";
import { query } from "@/lib/dsql";

/**
 * Records every model call so usage can be shown, capped and (later) priced
 * per outcome. Cost is estimated from a small per-model price table; unknown
 * models fall back to a conservative default so caps still bite.
 */

export type UsageFeature = "agent" | "copilot" | "chat" | "playbook" | "receptionist" | "generate" | "other";

/** USD per 1M tokens: [input, output]. Kept deliberately small and easy to edit. */
const PRICES_PER_M: Record<string, [number, number]> = {
  "llama-3.3-70b-versatile": [0.59, 0.79],
  "llama-3.1-8b-instant": [0.05, 0.08],
  "gemini-1.5-flash": [0.075, 0.3],
  "gemini-2.0-flash": [0.1, 0.4],
  "gemini-1.5-pro": [1.25, 5.0],
};
const DEFAULT_PRICE: [number, number] = [1.0, 3.0];

export function estimateCostMicros(model: string, promptTokens: number, completionTokens: number): number {
  const [inP, outP] = PRICES_PER_M[model] ?? DEFAULT_PRICE;
  const usd = (promptTokens / 1e6) * inP + (completionTokens / 1e6) * outP;
  return Math.round(usd * 1e6);
}

export interface UsageEvent {
  runId?: string | null;
  feature: UsageFeature;
  provider: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
}

/** Never throws — metering must not take a run down. Returns the cost recorded. */
export async function recordUsage(userId: string, u: UsageEvent): Promise<number> {
  const cost = estimateCostMicros(u.model, u.promptTokens, u.completionTokens);
  try {
    await query(
      `INSERT INTO ai_usage (id, user_id, run_id, feature, provider, model, prompt_tokens, completion_tokens, cost_micros)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [randomUUID(), userId, u.runId ?? null, u.feature, u.provider, u.model, u.promptTokens, u.completionTokens, cost]
    );
  } catch (err) {
    console.error("[metering] failed to record usage:", err);
  }
  return cost;
}
