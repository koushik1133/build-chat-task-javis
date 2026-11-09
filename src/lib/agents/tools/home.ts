import { z } from "zod";
import { registerTool } from "@/lib/agents/registry";
import type { ToolResult } from "@/lib/agents/types";
import { buildHomeSummary } from "@/lib/home/summary";

/** Home tools: the same one-round-trip summary that powers /home. */

const SummaryInput = z.object({});
registerTool<z.infer<typeof SummaryInput>>({
  name: "home.summary",
  module: "home",
  description: "Workspace overview: KPI tiles with month-over-month deltas, items that need the owner's attention, today's timeline, recent agent runs and a cashflow sparkline.",
  input: SummaryInput,
  parameters: { type: "object", properties: {} },
  scope: "read",
  preview: () => "Workspace summary",
  async run(ctx): Promise<ToolResult> {
    try {
      const s = await buildHomeSummary({ dataId: ctx.userId, can: () => true });
      const kpis = (s.kpis ?? []).map((k) => `${k.label}: ${k.value}${k.hint ? ` (${k.hint})` : ""}`);
      return {
        ok: true,
        data: { generatedAt: s.generatedAt, currency: s.currency, kpis: s.kpis, needsYou: s.needsYou, today: s.today, agents: s.agents, empty: s.empty },
        summary: s.empty ? "The workspace has no business data yet." : `${kpis.join(" · ") || "no KPIs"}; ${s.needsYou?.length ?? 0} item(s) need attention`,
      };
    } catch (err) {
      return { ok: false, summary: "Summary failed", error: err instanceof Error ? err.message : String(err) };
    }
  },
});
