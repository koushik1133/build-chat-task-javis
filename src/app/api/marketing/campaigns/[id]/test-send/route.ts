import { NextResponse, type NextRequest } from "next/server";
import { parseBody, paramId } from "@/lib/money/http";
import { rateLimitAllAsync } from "@/lib/request-limits";
import { queryOne } from "@/lib/dsql";
import { getCampaign, testSend } from "@/lib/marketing/campaigns";
import { marketingError, marketingScope } from "@/lib/marketing/http";
import { TestSendSchema } from "@/lib/marketing/schemas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST { email } | { phone } — sends the campaign content to the operator; never touches recipients. */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = await marketingScope(true);
  if (!s.ok) return s.res;
  // Test sends skip the consent gate, so they are capped per *org* (not per member) and per minute and per day.
  const limited = await rateLimitAllAsync(`marketing:test-send:${s.scope.dataId}`, [
    { name: "minute", limit: 10, windowMs: 60_000 },
    { name: "day", limit: 100, windowMs: 24 * 60 * 60_000 },
  ]);
  if (!limited.allowed) return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  const body = await parseBody(req, TestSendSchema, 4_000);
  if (!body.ok) return body.res;
  try {
    const id = await paramId(ctx);
    const campaign = await getCampaign(s.scope.dataId, id);
    if (!campaign) return NextResponse.json({ error: "not_found" }, { status: 404 });
    const to = campaign.channel === "email" ? (body.data.email ?? s.scope.email) : body.data.phone;
    if (!to) return NextResponse.json({ error: "invalid_body", detail: campaign.channel === "email" ? "Provide an email address." : "Provide a phone number." }, { status: 400 });
    // Email test sends only go to the operator or another member of this workspace: the platform sender must not relay to arbitrary addresses.
    if (campaign.channel === "email" && !(await isWorkspaceEmail(s.scope.dataId, s.scope.email, to))) {
      return NextResponse.json({ error: "invalid_body", detail: "Test emails can only be sent to your own address or another member of this workspace." }, { status: 400 });
    }
    const r = await testSend(s.scope.dataId, id, to);
    return NextResponse.json({ ok: true, outbox_id: r.outboxId, to });
  } catch (err) {
    return marketingError(err, "marketing/campaigns.test-send");
  }
}

async function isWorkspaceEmail(dataId: string, selfEmail: string | null, to: string): Promise<boolean> {
  const target = to.trim().toLowerCase();
  if (selfEmail && selfEmail.trim().toLowerCase() === target) return true;
  const member = await queryOne<{ id: string }>(
    `SELECT m.id FROM memberships m JOIN organizations o ON o.id = m.org_id
      WHERE o.owner_user_id = $1 AND m.status IN ('active', 'invited') AND lower(m.invited_email) = $2 LIMIT 1`,
    [dataId, target]
  ).catch(() => null);
  return Boolean(member);
}
