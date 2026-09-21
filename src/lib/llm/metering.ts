import { randomUUID } from "crypto";
import { query } from "@/lib/dsql";
import { assertBudget } from "@/lib/llm/budgets";
import { completeWithTools, type CompleteWithToolsOptions } from "@/lib/llm/router";
import type { RouterMessage } from "@/lib/agents/types";

export { estimateCostMicros } from "@/lib/llm/pricing";
import { estimateCostMicros } from "@/lib/llm/pricing";

/**
 * Records every model call so usage can be shown, capped and (later) priced
 * per outcome. Cost is estimated from a small per-model price table
 * (see ./pricing.ts).
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

export interface MeteredCompleteOptions extends Omit<CompleteWithToolsOptions, "tools"> {
  runId?: string | null;
}

/**
 * Budget-checked, metered plain completion for non-agent features
 * (chat, copilot, generate). Throws LlmBudgetExceededError at the cap and
 * LlmNotConfiguredError when no provider is available.
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
  await recordUsage(userId, {
    runId: runId ?? null,
    feature,
    provider: res.provider,
    model: res.model,
    promptTokens: res.promptTokens,
    completionTokens: res.completionTokens,
  });
  return res.content ?? "";
}
