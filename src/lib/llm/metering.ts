import { randomUUID } from "crypto";
import { query } from "@/lib/dsql";
import { assertBudget } from "@/lib/llm/budgets";
import { completeWithTools, type CompleteWithToolsOptions } from "@/lib/llm/router";
import { chargeForUsage, type ChargeResult } from "@/lib/credits/ledger";
import { InsufficientCreditsError } from "@/lib/credits/errors";
import type { RouterMessage } from "@/lib/agents/types";

export { estimateCostMicros } from "@/lib/llm/pricing";
export { InsufficientCreditsError } from "@/lib/credits/errors";
import { estimateCostMicros } from "@/lib/llm/pricing";

/**
 * Records every model call so usage can be shown, capped and priced per
 * outcome. Cost is estimated from a small per-model price table (see
 * ./pricing.ts) and immediately debited from the user's credit balance
 * (cost × AI_CREDIT_MARKUP), keyed on the usage row so a retry never
 * double-charges.
 */

export type UsageFeature = "agent" | "copilot" | "chat" | "playbook" | "receptionist" | "generate" | "other";

export interface UsageEvent {
  runId?: string | null;
  feature: UsageFeature;
  provider: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
}

export interface UsageRecord {
  /** ai_usage row id (also the credit charge's idempotency key). */
  id: string;
  costMicros: number;
  /** Null when the ledger could not be written; metering never throws for that. */
  charge: ChargeResult | null;
}

/** Never throws — metering must not take a run down. */
export async function recordUsageDetailed(userId: string, u: UsageEvent): Promise<UsageRecord> {
  const id = randomUUID();
  const cost = estimateCostMicros(u.model, u.promptTokens, u.completionTokens);
  try {
    await query(
      `INSERT INTO ai_usage (id, user_id, run_id, feature, provider, model, prompt_tokens, completion_tokens, cost_micros)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [id, userId, u.runId ?? null, u.feature, u.provider, u.model, u.promptTokens, u.completionTokens, cost]
    );
  } catch (err) {
    console.error("[metering] failed to record usage:", err);
  }
  let charge: ChargeResult | null = null;
  try {
    charge = await chargeForUsage(userId, { usageId: id, costMicros: cost, runId: u.runId ?? null, feature: u.feature, model: u.model });
  } catch (err) {
    console.error("[metering] failed to charge credits:", err);
  }
  return { id, costMicros: cost, charge };
}

/** Never throws — metering must not take a run down. Returns the cost recorded. */
export async function recordUsage(userId: string, u: UsageEvent): Promise<number> {
  return (await recordUsageDetailed(userId, u)).costMicros;
}

export interface MeteredCompleteOptions extends Omit<CompleteWithToolsOptions, "tools"> {
  runId?: string | null;
}

/**
 * Budget-checked, metered plain completion for non-agent features
 * (chat, copilot, generate, eval judging). Throws LlmBudgetExceededError at
 * the cap, InsufficientCreditsError when credits are enforced and the call
 * drove the balance below zero, and LlmNotConfiguredError when no provider
 * is available.
 */
export async function meteredComplete(
  userId: string,
  feature: UsageFeature,
  messages: RouterMessage[],
  opts: MeteredCompleteOptions = {}
): Promise<string> {
  const budget = await assertBudget(userId);
  const { runId, ...rest } = opts;
  const res = await completeWithTools(messages, {
    ...rest,
    tools: undefined,
    allowlist: rest.allowlist ?? budget.allowlist,
  });
  const usage = await recordUsageDetailed(userId, {
    runId: runId ?? null,
    feature,
    provider: res.provider,
    model: res.model,
    promptTokens: res.promptTokens,
    completionTokens: res.completionTokens,
  });
  if (budget.creditsEnforced && usage.charge && usage.charge.balanceAfter < 0) {
    throw new InsufficientCreditsError(usage.charge.balanceAfter);
  }
  return res.content ?? "";
}
