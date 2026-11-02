import { z } from "zod";
import { registerTool } from "@/lib/agents/registry";
import type { ToolResult } from "@/lib/agents/types";
import { runCapacity, runCashflow, runPricing } from "@/lib/optimize";

/** Optimisation tools (read-only): cash-flow forecast, capacity plan, quote pricing suggestions. Money is minor units. */

function fail(error: string): ToolResult {
  return { ok: false, summary: error, error };
}
function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/* ---------- optimize.cashflow ---------- */
const CashflowInput = z.object({
  weeks: z.number().int().min(1).max(52).optional(),
  opening_balance_minor: z.number().int().optional(),
});
registerTool<z.infer<typeof CashflowInput>>({
  name: "optimize.cashflow",
  module: "optimize",
  description: "Forecast weekly cash in/out and balance from open invoices (with each client's typical days-to-pay), the quote/booking pipeline weighted by stage, and recurring + run-rate expenses. Returns weeks, risks and assumptions.",
  input: CashflowInput,
  parameters: {
    type: "object",
    properties: {
      weeks: { type: "integer", description: "Horizon in weeks (default 12)" },
      opening_balance_minor: { type: "integer", description: "Cash on hand today, minor units (default 0)" },
    },
  },
  scope: "read",
  preview: (i) => `Forecast cash flow for ${i.weeks ?? 12} weeks`,
  async run(ctx, input) {
    try {
      const f = await runCashflow(ctx.userId, { weeks: input.weeks, openingBalance: input.opening_balance_minor });
      const low = f.summary.lowestBalance;
      return {
        ok: true,
        data: { currency: f.currency, summary: f.summary, risks: f.risks, assumptions: f.assumptions, weeks: f.weeks },
        summary: `${f.weeks.length}-week forecast: ending balance ${(f.summary.endingBalance / 100).toFixed(0)} ${f.currency}, lowest ${(low / 100).toFixed(0)} in week ${f.summary.lowestWeek ?? "-"}, ${f.risks.length} risk flag(s)`,
      };
    } catch (err) {
      return fail(`Cash-flow forecast failed: ${errMsg(err)}`);
    }
  },
});

/* ---------- optimize.capacity ---------- */
const CapacityInput = z.object({
  weeks: z.number().int().min(1).max(26).optional(),
  target_pct: z.number().int().min(30).max(100).optional(),
});
registerTool<z.infer<typeof CapacityInput>>({
  name: "optimize.capacity",
  module: "optimize",
  description: "Plan team capacity: utilisation per week and per member from bookings, availability and logged time; bottleneck weeks and a hire / extra-hours suggestion.",
  input: CapacityInput,
  parameters: {
    type: "object",
    properties: {
      weeks: { type: "integer", description: "Future weeks to plan (default 8)" },
      target_pct: { type: "integer", description: "Utilisation target in percent (default 85)" },
    },
  },
  scope: "read",
  preview: (i) => `Plan capacity for ${i.weeks ?? 8} weeks`,
  async run(ctx, input) {
    try {
      const p = await runCapacity(ctx.userId, { weeks: input.weeks, target: input.target_pct ? input.target_pct / 100 : undefined });
      return {
        ok: true,
        data: { people: p.people, weeklyMinutesPerPerson: p.weeklyMinutesPerPerson, target: p.target, weeks: p.weeks, members: p.members.map((m) => ({ id: m.id, label: m.label, avgUtilisation: m.avgUtilisation })), bottleneckWeeks: p.bottleneckWeeks, suggestion: p.suggestion },
        summary: p.suggestion.message,
      };
    } catch (err) {
      return fail(`Capacity plan failed: ${errMsg(err)}`);
    }
  },
});

/* ---------- optimize.pricing ---------- */
const PricingInput = z.object({
  items: z
    .array(z.object({ description: z.string().trim().min(1).max(500), qty: z.number().min(0).max(1_000_000).optional(), unit_minor: z.number().int().min(0) }))
    .min(1)
    .max(50),
});
registerTool<z.infer<typeof PricingInput>>({
  name: "optimize.pricing",
  module: "optimize",
  description: "Suggest a price range per line item from past quotes: win rate by price band (accepted vs declined/expired), suggested unit price and the win probability at the current price.",
  input: PricingInput,
  parameters: {
    type: "object",
    properties: {
      items: {
        type: "array",
        items: { type: "object", properties: { description: { type: "string" }, qty: { type: "number" }, unit_minor: { type: "integer", description: "Current unit price, minor units" } }, required: ["description", "unit_minor"] },
      },
    },
    required: ["items"],
  },
  scope: "read",
  preview: (i) => `Suggest pricing for ${i.items.length} item(s)`,
  async run(ctx, input) {
    try {
      const s = await runPricing(ctx.userId, input.items.map((i) => ({ description: i.description, qty: i.qty ?? 1, unit_minor: i.unit_minor })));
      const withHistory = s.items.filter((i) => i.basis === "history").length;
      return {
        ok: true,
        data: s,
        summary: `${withHistory} of ${s.items.length} item(s) have pricing history; overall win rate ${Math.round(s.overall.winRate * 100)}% over ${s.overall.quotes} decided quotes`,
      };
    } catch (err) {
      return fail(`Pricing suggestion failed: ${errMsg(err)}`);
    }
  },
});
