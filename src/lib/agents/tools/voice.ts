import { z } from "zod";
import { registerTool } from "@/lib/agents/registry";
import type { ToolResult } from "@/lib/agents/types";
import { addTargets, createCampaign, getCampaign, listCampaigns, listTargets, setCampaignStatus, statsFor } from "@/lib/voice/campaigns";
import { voiceMode } from "@/lib/voice/dialer";
import { DEFAULT_VOICE, VOICES } from "@/lib/voice/twiml";
import { isValidTimeZone, parseHm } from "@/lib/voice/window";

/** Outbound voice campaign tools. Starting a campaign dials real people, so it always needs approval. */

function fail(error: string): ToolResult {
  return { ok: false, summary: error, error };
}
function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/* ---------- voice.list_campaigns ---------- */
registerTool<Record<string, never>>({
  name: "voice.list_campaigns",
  module: "voice",
  description: "List outbound voice campaigns with their status and call stats.",
  input: z.object({}).strict(),
  parameters: { type: "object", properties: {} },
  scope: "read",
  preview: () => "List voice campaigns",
  async run(ctx) {
    try {
      const rows = await listCampaigns(ctx.userId);
      return {
        ok: true,
        data: rows.map((c) => ({ id: c.id, name: c.name, status: c.status, timezone: c.timezone, window: `${c.window_start}-${c.window_end}`, stats: c.stats })),
        summary: `${rows.length} campaign(s) (${voiceMode()} dialer)`,
      };
    } catch (err) {
      return fail(`Could not list campaigns: ${errMsg(err)}`);
    }
  },
});

/* ---------- voice.start_campaign ---------- */
const StartInput = z
  .object({
    name: z.string().trim().min(1).max(120),
    script: z.string().trim().min(10).max(3000),
    voice: z.enum(VOICES).optional(),
    timezone: z.string().max(60).refine(isValidTimeZone, "Unknown timezone").optional(),
    window_start: z.string().refine((v) => parseHm(v) !== null, "Use HH:MM").optional(),
    window_end: z.string().refine((v) => parseHm(v) !== null, "Use HH:MM").optional(),
    max_attempts: z.number().int().min(1).max(5).optional(),
    contact_ids: z.array(z.string().min(1)).max(1000).optional(),
    lifecycle: z.string().max(40).optional(),
    tag: z.string().max(60).optional(),
    q: z.string().max(120).optional(),
  })
  .strict();
type StartInputT = z.infer<typeof StartInput>;

registerTool<StartInputT>({
  name: "voice.start_campaign",
  module: "voice",
  description:
    "Create AND start an outbound voice campaign that calls CRM contacts with a spoken script ({{first_name}} is merged). Audience is explicit contact_ids or a filter (lifecycle, tag, q). Contacts on the do-not-call list are skipped. Always requires human approval.",
  input: StartInput,
  parameters: {
    type: "object",
    properties: {
      name: { type: "string" },
      script: { type: "string", description: "What the call says. Supports {{first_name}}, {{full_name}}, {{company}}." },
      voice: { type: "string", enum: [...VOICES] },
      timezone: { type: "string", description: "IANA timezone for the calling window, e.g. America/New_York" },
      window_start: { type: "string", description: "HH:MM local, default 09:00" },
      window_end: { type: "string", description: "HH:MM local, default 18:00" },
      max_attempts: { type: "integer", minimum: 1, maximum: 5 },
      contact_ids: { type: "array", items: { type: "string" } },
      lifecycle: { type: "string", description: "Audience filter: lead | prospect | customer | …" },
      tag: { type: "string", description: "Audience filter: contacts carrying this tag" },
      q: { type: "string", description: "Audience filter: name/company/email contains" },
    },
    required: ["name", "script"],
  },
  scope: "write",
  requiresApproval: true,
  preview: (i) => {
    const aud = i.contact_ids?.length ? `${i.contact_ids.length} contact(s)` : [i.lifecycle && `lifecycle=${i.lifecycle}`, i.tag && `tag=${i.tag}`, i.q && `q="${i.q}"`].filter(Boolean).join(", ") || "no audience";
    return `Start voice campaign "${i.name}" → ${aud} (${i.window_start ?? "09:00"}–${i.window_end ?? "18:00"} ${i.timezone ?? "UTC"})`;
  },
  async run(ctx, input) {
    try {
      const hasAudience = Boolean(input.contact_ids?.length || input.lifecycle || input.tag || input.q);
      if (!hasAudience) return fail("Give the campaign an audience: contact_ids or a lifecycle/tag/q filter.");
      const campaign = await createCampaign(ctx.userId, {
        name: input.name,
        script: input.script,
        voice: input.voice ?? DEFAULT_VOICE,
        schedule_at: null,
        window_start: input.window_start ?? "09:00",
        window_end: input.window_end ?? "18:00",
        timezone: input.timezone ?? "UTC",
        max_attempts: input.max_attempts ?? 2,
        created_by: ctx.agentId ? `agent:${ctx.agentId}` : ctx.userId,
      });
      const audience = await addTargets(ctx.userId, campaign.id, {
        contact_ids: input.contact_ids,
        filter: input.lifecycle || input.tag || input.q ? { lifecycle: input.lifecycle ?? null, tag: input.tag ?? null, q: input.q ?? null } : null,
      });
      if (audience.added === 0) {
        return { ok: true, data: { campaign_id: campaign.id, audience, status: "draft" }, summary: `Campaign "${campaign.name}" saved as draft — no callable contacts matched (${audience.skipped_dnc} on do-not-call).` };
      }
      const started = await setCampaignStatus(ctx.userId, campaign.id, "running");
      return {
        ok: true,
        data: { campaign_id: campaign.id, status: started?.status ?? "running", audience, mode: voiceMode() },
        summary: `Started campaign "${campaign.name}" with ${audience.added} target(s)${audience.skipped_dnc ? `, ${audience.skipped_dnc} skipped (do-not-call)` : ""} — ${voiceMode()} dialer.`,
      };
    } catch (err) {
      return fail(`Could not start campaign: ${errMsg(err)}`);
    }
  },
});

/* ---------- voice.campaign_status ---------- */
const StatusInput = z.object({ campaign_id: z.string().min(1).max(100) }).strict();
type StatusInputT = z.infer<typeof StatusInput>;

registerTool<StatusInputT>({
  name: "voice.campaign_status",
  module: "voice",
  description: "Stats and recent outcomes for one voice campaign.",
  input: StatusInput,
  parameters: { type: "object", properties: { campaign_id: { type: "string" } }, required: ["campaign_id"] },
  scope: "read",
  preview: (i) => `Voice campaign status ${i.campaign_id}`,
  async run(ctx, input) {
    try {
      const campaign = await getCampaign(ctx.userId, input.campaign_id);
      if (!campaign) return fail("Campaign not found");
      const targets = await listTargets(ctx.userId, campaign.id);
      const stats = statsFor(targets);
      return { ok: true, data: { campaign: { id: campaign.id, name: campaign.name, status: campaign.status }, stats }, summary: `${campaign.name}: ${campaign.status}, ${stats.answered} answered / ${stats.total} targets, ${stats.interested} interested` };
    } catch (err) {
      return fail(`Could not load campaign: ${errMsg(err)}`);
    }
  },
});

/* ---------- voice.pause_campaign ---------- */
registerTool<StatusInputT>({
  name: "voice.pause_campaign",
  module: "voice",
  description: "Pause a running voice campaign so no further calls are placed.",
  input: StatusInput,
  parameters: { type: "object", properties: { campaign_id: { type: "string" } }, required: ["campaign_id"] },
  scope: "write",
  requiresApproval: false,
  preview: (i) => `Pause voice campaign ${i.campaign_id}`,
  async run(ctx, input) {
    try {
      const campaign = await getCampaign(ctx.userId, input.campaign_id);
      if (!campaign) return fail("Campaign not found");
      if (campaign.status !== "running" && campaign.status !== "scheduled") return fail(`Campaign is ${campaign.status}, nothing to pause.`);
      await setCampaignStatus(ctx.userId, campaign.id, "paused");
      return { ok: true, data: { campaign_id: campaign.id, status: "paused" }, summary: `Paused "${campaign.name}"` };
    } catch (err) {
      return fail(`Could not pause campaign: ${errMsg(err)}`);
    }
  },
});
