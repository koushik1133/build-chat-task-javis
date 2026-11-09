import { z } from "zod";
import { registerTool } from "@/lib/agents/registry";
import type { ToolResult } from "@/lib/agents/types";
import { buildPlanSummary } from "@/lib/plans/entitlements";
import { METRIC_LABEL } from "@/lib/plans/catalog";
import { usagePercent } from "@/lib/plans/rules";

/** Read-only view of the workspace's KernelHub plan, limits and usage. */

const UsageInput = z.object({});
type UsageInputT = z.infer<typeof UsageInput>;

registerTool<UsageInputT>({
  name: "plan.usage",
  module: "plan",
  description: "Read the workspace's KernelHub plan, trial state, feature entitlements and usage against each limit (seats, contacts, storage, AI credits, workspaces).",
  input: UsageInput,
  parameters: { type: "object", properties: {} },
  scope: "read",
  preview: () => "Check plan and usage",
  async run(ctx): Promise<ToolResult> {
    try {
      const s = await buildPlanSummary(ctx.userId);
      const ent = s.entitlements;
      const data = {
        plan: ent.plan,
        status: ent.status,
        enforced: s.enforced,
        trial_days_left: ent.trial.active ? ent.trial.daysLeft : null,
        features: ent.features,
        usage: s.usage.map((u) => ({ metric: u.metric, label: METRIC_LABEL[u.metric], used: u.used, limit: u.limit, percent: usagePercent(u.used, u.limit) })),
      };
      const hot = data.usage.filter((u) => u.percent >= 80).map((u) => `${u.label} ${u.percent}%`);
      return { ok: true, data, summary: `${ent.plan} plan (${ent.status})${hot.length ? ` — near limit: ${hot.join(", ")}` : ""}${s.enforced ? "" : "; limits not enforced"}` };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, summary: msg, error: msg };
    }
  },
});
