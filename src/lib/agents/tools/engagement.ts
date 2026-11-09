import { z } from "zod";
import { registerTool } from "@/lib/agents/registry";
import type { ToolResult } from "@/lib/agents/types";
import { query } from "@/lib/dsql";
import { getAccount, getProgram } from "@/lib/engagement/loyalty";
import { issuePersonalVoucher } from "@/lib/engagement/vouchers";
import { npsStats } from "@/lib/engagement/pure";

/** Engagement tools: NPS summary, loyalty balance lookup and single-use voucher issuing. */

const fail = (error: string): ToolResult => ({ ok: false, summary: error, error });
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/* ---------- engagement.nps ---------- */
const NpsInput = z.object({ days: z.number().int().min(1).max(730).optional() });
type NpsInputT = z.infer<typeof NpsInput>;
registerTool<NpsInputT>({
  name: "engagement.nps",
  module: "engagement",
  description: "Net Promoter Score and response count across NPS surveys for the last N days (default 90).",
  input: NpsInput,
  parameters: { type: "object", properties: { days: { type: "number", description: "Look-back window in days (default 90)" } } },
  scope: "read",
  preview: (i) => `NPS for the last ${i.days ?? 90} days`,
  async run(ctx, input) {
    try {
      const days = input.days ?? 90;
      const rows = await query<{ score: number }>(
        `SELECT r.score FROM survey_responses r JOIN surveys s ON s.id = r.survey_id AND s.user_id = r.user_id WHERE r.user_id = $1 AND s.kind = 'nps' AND r.score IS NOT NULL AND r.created_at >= NOW() - ($2 || ' days')::interval`,
        [ctx.userId, String(days)]
      );
      const stats = npsStats(rows.map((r) => Number(r.score)));
      return { ok: true, summary: stats.nps === null ? "No NPS responses in this period" : `NPS ${stats.nps} from ${stats.total} responses (${stats.promoters} promoters, ${stats.detractors} detractors)`, data: { days, ...stats } };
    } catch (err) {
      return fail(errMsg(err));
    }
  },
});

/* ---------- engagement.loyalty_balance ---------- */
const BalInput = z.object({ contact_id: z.string().min(1).max(100) });
type BalInputT = z.infer<typeof BalInput>;
registerTool<BalInputT>({
  name: "engagement.loyalty_balance",
  module: "engagement",
  description: "A contact's loyalty points balance, tier and lifetime points.",
  input: BalInput,
  parameters: { type: "object", properties: { contact_id: { type: "string", description: "CRM contact id" } }, required: ["contact_id"] },
  scope: "read",
  preview: (i) => `Loyalty balance for ${i.contact_id}`,
  async run(ctx, input) {
    try {
      const program = await getProgram(ctx.userId);
      if (!program.enabled) return { ok: true, summary: "The rewards program is not enabled", data: { enabled: false } };
      const a = await getAccount(ctx.userId, input.contact_id);
      return { ok: true, summary: a ? `${a.balance} points (${a.tier ?? "no tier"})` : "No points yet", data: { enabled: true, balance: a?.balance ?? 0, lifetime_points: a?.lifetime_points ?? 0, tier: a?.tier ?? null } };
    } catch (err) {
      return fail(errMsg(err));
    }
  },
});

/* ---------- engagement.issue_voucher ---------- */
const VInput = z.object({
  name: z.string().min(1).max(120),
  kind: z.enum(["percent", "fixed"]),
  value_bp: z.number().int().min(1).max(10_000).optional().describe("percent: basis points (1500 = 15%)"),
  value_minor: z.number().int().min(1).max(1_000_000_000).optional().describe("fixed: minor units"),
  currency: z.string().length(3).optional(),
  expires_in_days: z.number().int().min(1).max(365).optional(),
});
type VInputT = z.infer<typeof VInput>;
registerTool<VInputT>({
  name: "engagement.issue_voucher",
  module: "engagement",
  description: "Create a single-use personal voucher code (percent or fixed amount). Returns the code. Needs approval because it gives value away.",
  input: VInput,
  parameters: {
    type: "object",
    properties: {
      name: { type: "string" },
      kind: { type: "string", enum: ["percent", "fixed"] },
      value_bp: { type: "number", description: "Percent in basis points (1500 = 15%)" },
      value_minor: { type: "number", description: "Fixed amount in minor units" },
      currency: { type: "string", description: "ISO currency for fixed vouchers" },
      expires_in_days: { type: "number" },
    },
    required: ["name", "kind"],
  },
  scope: "write",
  risk: "medium",
  requiresApproval: () => true,
  preview: (i) => `Issue ${i.kind === "percent" ? `${(i.value_bp ?? 0) / 100}%` : `${i.value_minor ?? 0} minor`} voucher "${i.name}"`,
  async run(ctx, input) {
    try {
      const value = input.kind === "percent" ? input.value_bp : input.value_minor;
      if (!value) return fail(input.kind === "percent" ? "value_bp is required for percent vouchers" : "value_minor is required for fixed vouchers");
      const v = await issuePersonalVoucher(ctx.userId, { name: input.name, kind: input.kind, value, currency: input.currency, endsInDays: input.expires_in_days });
      return { ok: true, summary: `Voucher ${v.code_upper} created`, data: { id: v.id, code: v.code_upper, kind: v.kind, value: v.value } };
    } catch (err) {
      return fail(errMsg(err));
    }
  },
});
