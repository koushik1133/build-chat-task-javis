import { z } from "zod";
import { registerTool } from "@/lib/agents/registry";
import type { ToolResult } from "@/lib/agents/types";
import { rollup } from "@/lib/agency/rollup";

/** Agency tools: cross-workspace roll-up for parent orgs. */

function fail(error: string): ToolResult {
  return { ok: false, summary: error, error };
}

const RollupInput = z.object({
  days: z.number().int().min(1).max(365).optional().describe("Window ending now (default 30)"),
});
registerTool<z.infer<typeof RollupInput>>({
  name: "agency.rollup",
  module: "agency",
  description: "Per-client KPIs (revenue, open quotes, bookings, open tickets, AI spend) across every client workspace of this agency, with totals.",
  input: RollupInput,
  parameters: { type: "object", properties: { days: { type: "integer", description: "Lookback window in days (default 30)" } } },
  scope: "read",
  preview: (i) => `Agency roll-up, last ${i.days ?? 30} days`,
  async run(ctx, input) {
    try {
      const to = new Date();
      const from = new Date(to.getTime() - (input.days ?? 30) * 86_400_000);
      const report = await rollup(ctx.userId, { from: from.toISOString(), to: to.toISOString() });
      const t = report.totals;
      return {
        ok: true,
        data: report,
        summary: `${t.clients} client(s): revenue ${t.revenue_minor} minor units (${t.currencies.join("/") || "n/a"}), ${t.open_quotes} open quotes, ${t.bookings} bookings, ${t.open_tickets} open tickets`,
      };
    } catch (err) {
      return fail(`Roll-up failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
});
