import { NextRequest, NextResponse } from "next/server";
import { requireScope, scopeErrorResponse } from "@/lib/auth/scope";
import { addTargets, getCampaign, hasFilterCriteria } from "@/lib/voice/campaigns";
import { audienceSchema } from "@/lib/voice/schemas";

export const dynamic = "force-dynamic";

/** Add contacts / phones to a campaign's target list (DNC filtered, de-duplicated). */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  let scope;
  try {
    scope = await requireScope({ area: "messaging", edit: true });
  } catch (err) {
    return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { id } = await ctx.params;
  const parsed = audienceSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid body" }, { status: 400 });
  if (!parsed.data.contact_ids?.length && !hasFilterCriteria(parsed.data.filter) && !parsed.data.phones?.length) {
    return NextResponse.json({ error: "Provide contact_ids, a filter or phones." }, { status: 400 });
  }
  try {
    const campaign = await getCampaign(scope.dataId, id);
    if (!campaign) return NextResponse.json({ error: "Campaign not found" }, { status: 404 });
    if (campaign.status === "done") return NextResponse.json({ error: "This campaign is finished." }, { status: 409 });
    const result = await addTargets(scope.dataId, id, parsed.data);
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    console.error("[voice/campaigns/:id/targets] failed:", err);
    return NextResponse.json({ error: "Could not add targets." }, { status: 500 });
  }
}
