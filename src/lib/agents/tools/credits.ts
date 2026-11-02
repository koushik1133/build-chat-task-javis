import { z } from "zod";
import { registerTool } from "@/lib/agents/registry";
import { getBalance } from "@/lib/credits/ledger";
import { creditsToUnits, creditMarkup } from "@/lib/credits/pricing";
import { getBudget } from "@/lib/llm/budgets";
import type { ToolResult } from "@/lib/agents/types";

/** Read-only view of the AI credit balance, so an agent can report or warn about it. */

const BalanceInput = z.object({});
type BalanceInputT = z.infer<typeof BalanceInput>;

registerTool<BalanceInputT>({
  name: "credits.balance",
  module: "credits",
  description: "Read the workspace's AI credit balance (1 credit = $0.001), whether credits are enforced, and the usage markup.",
  input: BalanceInput,
  parameters: { type: "object", properties: {} },
  scope: "read",
  preview: () => "Check AI credit balance",
  async run(ctx): Promise<ToolResult> {
    try {
      const [balance, budget] = await Promise.all([getBalance(ctx.userId), getBudget(ctx.userId)]);
      const data = {
        balance_credits: balance,
        balance_usd: Number(creditsToUnits(balance).toFixed(3)),
        credits_enforced: budget.creditsEnforced,
        markup: creditMarkup(),
        low: balance < 1000,
      };
      return { ok: true, data, summary: `${balance.toLocaleString()} credits (≈ $${data.balance_usd})${data.low ? " — running low" : ""}` };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      return { ok: false, summary: `Could not read credit balance: ${error}`, error };
    }
  },
});
