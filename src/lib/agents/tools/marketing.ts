import { z } from "zod";
import { registerTool } from "@/lib/agents/registry";
import type { ToolResult } from "@/lib/agents/types";
import { countAudience, eligibleCount, getAudience } from "@/lib/marketing/audiences";
import { campaignStats, getCampaign, listCampaigns } from "@/lib/marketing/campaigns";
import { enroll, findSequence } from "@/lib/marketing/sequences";
import { parseAudienceDefinition } from "@/lib/marketing/types";

/** Marketing tools: consent-first audience counts, campaign stats, sequence enrollment (approval). */

function fail(error: string): ToolResult {
  return { ok: false, summary: error, error };
}
function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/* ---------- marketing.enroll ---------- */
const EnrollInput = z
  .object({
    sequence: z.string().trim().min(1).max(120).describe("Sequence id or exact name (e.g. 'Welcome')"),
    contact_id: z.string().trim().min(1).max(80),
  })
  .strict();
type EnrollInputT = z.infer<typeof EnrollInput>;

registerTool<EnrollInputT>({
  name: "marketing.enroll",
  module: "marketing",
  description:
    "Enroll a CRM contact into a drip sequence by sequence id or name. Each step is consent-checked at send time (no marketing consent → the contact exits without receiving anything). Idempotent. Requires approval.",
  input: EnrollInput,
  parameters: {
    type: "object",
    properties: {
      sequence: { type: "string", description: "Sequence id or exact name" },
      contact_id: { type: "string", description: "CRM contact id" },
    },
    required: ["sequence", "contact_id"],
  },
  scope: "write",
  requiresApproval: true,
  preview: (i) => `Enroll contact ${i.contact_id} into sequence "${i.sequence}"`,
  async run(ctx, input) {
    try {
      const seq = await findSequence(ctx.userId, input.sequence);
      if (!seq) return fail(`No sequence matches "${input.sequence}". Create one under Marketing → Sequences.`);
      const r = await enroll(ctx.userId, seq.id, input.contact_id, "tool");
      if (!r.ok) return fail(`Could not enroll: ${r.reason.replace(/_/g, " ")}`);
      return {
        ok: true,
        summary: r.created ? `Enrolled contact ${input.contact_id} into "${seq.name}" (first step due ${r.enrollment.next_at ?? "now"})` : `Contact ${input.contact_id} is already in "${seq.name}" (${r.enrollment.status})`,
        data: { sequence: { id: seq.id, name: seq.name }, enrollment: r.enrollment, created: r.created },
      };
    } catch (err) {
      return fail(`Enrollment failed: ${errMsg(err)}`);
    }
  },
});

/* ---------- marketing.campaign_stats ---------- */
const StatsInput = z.object({ campaign_id: z.string().trim().max(80).optional().describe("Campaign id; omit to list recent campaigns with stats") }).strict();
type StatsInputT = z.infer<typeof StatsInput>;

registerTool<StatsInputT>({
  name: "marketing.campaign_stats",
  module: "marketing",
  description: "Funnel stats for an email/SMS campaign (sent → delivered → opened → clicked → unsubscribed, plus consent skips). Without campaign_id, lists the 20 most recent campaigns.",
  input: StatsInput,
  parameters: { type: "object", properties: { campaign_id: { type: "string" } } },
  scope: "read",
  preview: (i) => (i.campaign_id ? `Stats for campaign ${i.campaign_id}` : "List campaigns"),
  async run(ctx, input) {
    try {
      if (input.campaign_id) {
        const c = await getCampaign(ctx.userId, input.campaign_id);
        if (!c) return fail("Campaign not found");
        const stats = await campaignStats(ctx.userId, c.id);
        return {
          ok: true,
          summary: `${c.name} (${c.status}): ${stats.sent + stats.delivered + stats.bounced + stats.unsubscribed} sent, ${stats.delivered} delivered, ${stats.opened} opened (${stats.open_rate}%), ${stats.clicked} clicked (${stats.click_rate}%), ${stats.unsubscribed} unsubscribed, ${stats.skipped_no_consent} skipped for consent`,
          data: { campaign: { id: c.id, name: c.name, channel: c.channel, status: c.status, started_at: c.started_at, finished_at: c.finished_at }, stats },
        };
      }
      const rows = await listCampaigns(ctx.userId, { limit: 20 });
      return { ok: true, summary: `${rows.length} campaign(s)`, data: rows.map((c) => ({ id: c.id, name: c.name, channel: c.channel, status: c.status, sent: c.sent_count, delivered: c.delivered_count, opened: c.opened_count, clicked: c.clicked_count, unsubscribed: c.unsubscribed_count })) };
    } catch (err) {
      return fail(`Could not load stats: ${errMsg(err)}`);
    }
  },
});

/* ---------- marketing.audience_count ---------- */
const CountInput = z.object({ audience_id: z.string().trim().min(1).max(80), channel: z.enum(["email", "sms"]).optional() }).strict();
type CountInputT = z.infer<typeof CountInput>;

registerTool<CountInputT>({
  name: "marketing.audience_count",
  module: "marketing",
  description: "How many contacts an audience resolves to, and how many of them may legally receive marketing on a channel (consent + opt-outs). Use before proposing a campaign.",
  input: CountInput,
  parameters: { type: "object", properties: { audience_id: { type: "string" }, channel: { type: "string", enum: ["email", "sms"], description: "Default email" } }, required: ["audience_id"] },
  scope: "read",
  preview: (i) => `Count audience ${i.audience_id}`,
  async run(ctx, input) {
    try {
      const a = await getAudience(ctx.userId, input.audience_id);
      if (!a) return fail("Audience not found");
      const def = parseAudienceDefinition(a.definition);
      const channel = input.channel ?? "email";
      const [total, eligible] = await Promise.all([countAudience(ctx.userId, def), eligibleCount(ctx.userId, def, channel)]);
      return { ok: true, summary: `${a.name}: ${total} contact(s), ${eligible.eligible} eligible for ${channel} marketing`, data: { audience: { id: a.id, name: a.name }, total, eligible: eligible.eligible, channel } };
    } catch (err) {
      return fail(`Could not count audience: ${errMsg(err)}`);
    }
  },
});
