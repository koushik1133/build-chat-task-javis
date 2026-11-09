import { NextResponse, type NextRequest } from "next/server";
import { parseBody, paramId } from "@/lib/money/http";
import { rateLimitAsync } from "@/lib/request-limits";
import { getCampaign, testSend } from "@/lib/marketing/campaigns";
import { marketingError, marketingScope } from "@/lib/marketing/http";
import { TestSendSchema } from "@/lib/marketing/schemas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST { email } | { phone } — sends the campaign content to the operator; never touches recipients. */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = await marketingScope(true);
  if (!s.ok) return s.res;
  if (!(await rateLimitAsync(`marketing:test-send:${s.scope.userId}`, 20, 60_000)).allowed) return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  const body = await parseBody(req, TestSendSchema, 4_000);
  if (!body.ok) return body.res;
  try {
    const id = await paramId(ctx);
    const campaign = await getCampaign(s.scope.dataId, id);
    if (!campaign) return NextResponse.json({ error: "not_found" }, { status: 404 });
    const to = campaign.channel === "email" ? (body.data.email ?? s.scope.email) : body.data.phone;
    if (!to) return NextResponse.json({ error: "invalid_body", detail: campaign.channel === "email" ? "Provide an email address." : "Provide a phone number." }, { status: 400 });
    const r = await testSend(s.scope.dataId, id, to);
    return NextResponse.json({ ok: true, outbox_id: r.outboxId, to });
  } catch (err) {
    return marketingError(err, "marketing/campaigns.test-send");
  }
}
