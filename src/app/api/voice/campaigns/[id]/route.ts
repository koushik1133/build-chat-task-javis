import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireScope, scopeErrorResponse } from "@/lib/auth/scope";
import { canTransition, getCampaign, listCalls, listTargets, setCampaignStatus, statsFor } from "@/lib/voice/campaigns";
import { voiceMode } from "@/lib/voice/dialer";
import { canDialNow } from "@/lib/voice/window";

export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  let scope;
  try {
    scope = await requireScope({ area: "messaging", edit: false });
  } catch (err) {
    return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { id } = await ctx.params;
  try {
    const campaign = await getCampaign(scope.dataId, id);
    if (!campaign) return NextResponse.json({ error: "Campaign not found" }, { status: 404 });
    const [targets, calls] = await Promise.all([listTargets(scope.dataId, id), listCalls(scope.dataId, id, 100)]);
    return NextResponse.json({
      campaign,
      targets,
      calls,
      stats: statsFor(targets),
      mode: voiceMode(),
      windowOpen: canDialNow(new Date(), campaign),
    });
  } catch (err) {
    console.error("[voice/campaigns/:id] failed:", err);
    return NextResponse.json({ error: "Could not load the campaign." }, { status: 500 });
  }
}

const patchSchema = z.object({ status: z.enum(["running", "paused", "done", "scheduled", "draft"]) }).strict();

/** Start / pause / finish a campaign. */
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  let scope;
  try {
    scope = await requireScope({ area: "messaging", edit: true });
  } catch (err) {
    return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { id } = await ctx.params;
  const parsed = patchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid body" }, { status: 400 });
  try {
    const campaign = await getCampaign(scope.dataId, id);
    if (!campaign) return NextResponse.json({ error: "Campaign not found" }, { status: 404 });
    let next = parsed.data.status;
    if (next === "running" && campaign.schedule_at && new Date(campaign.schedule_at).getTime() > Date.now()) next = "scheduled";
    if (!canTransition(campaign.status, next)) {
      return NextResponse.json({ error: `A ${campaign.status} campaign cannot move to ${next}.` }, { status: 409 });
    }
    const updated = await setCampaignStatus(scope.dataId, id, next);
    return NextResponse.json({ campaign: updated });
  } catch (err) {
    console.error("[voice/campaigns/:id] patch failed:", err);
    return NextResponse.json({ error: "Could not update the campaign." }, { status: 500 });
  }
}
