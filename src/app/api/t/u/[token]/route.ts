import { NextResponse, type NextRequest } from "next/server";
import { rateLimitAsync, clientIp } from "@/lib/request-limits";
import { resolveUnsubscribeRecipient, unsubscribe, type UnsubscribeTarget } from "@/lib/marketing/campaigns";
import { verifyToken } from "@/lib/marketing/tracking";
import { getBranding } from "@/lib/branding";
import { queryOne } from "@/lib/dsql";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function resolve(token: string): Promise<UnsubscribeTarget | null> {
  const payload = verifyToken(token);
  if (!payload) return null;
  if (payload.kind === "unsub") return resolveUnsubscribeRecipient(payload.recipientId);
  if (payload.kind === "unsub_contact") {
    const c = await queryOne<{ id: string }>(`SELECT id FROM crm_contacts WHERE user_id = $1 AND id = $2`, [payload.dataId, payload.contactId]).catch(() => null);
    return c ? { dataId: payload.dataId, contactId: payload.contactId, recipientId: null, campaignId: null, channel: payload.channel } : null;
  }
  return null;
}

/** GET → describe the link (brand name, channel) for the public page. */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const target = await resolve(token);
  if (!target) return NextResponse.json({ error: "invalid_token" }, { status: 404 });
  const branding = await getBranding(target.dataId).catch(() => null);
  const already = target.recipientId ? await queryOne<{ status: string }>(`SELECT status FROM campaign_recipients WHERE id = $1`, [target.recipientId]).catch(() => null) : null;
  return NextResponse.json({ business: branding?.brand_name ?? null, channel: target.channel, already_unsubscribed: already?.status === "unsubscribed" }, { headers: { "Cache-Control": "no-store", "X-Robots-Tag": "noindex" } });
}

/**
 * POST → withdraw consent. Also the RFC 8058 one-click target
 * (List-Unsubscribe-Post: List-Unsubscribe=One-Click), so form bodies are accepted.
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  if (!(await rateLimitAsync(`t:unsub:${clientIp(req)}`, 30, 60_000)).allowed) return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  const target = await resolve(token);
  if (!target) return NextResponse.json({ error: "invalid_token" }, { status: 404 });
  let all = false;
  const ct = req.headers.get("content-type") ?? "";
  if (ct.includes("application/json")) {
    const body = (await req.json().catch(() => null)) as { all?: unknown } | null;
    all = body?.all === true;
  } else if (ct.includes("form")) {
    const form = await req.formData().catch(() => null);
    all = form?.get("all") === "1" || form?.get("all") === "true";
  }
  try {
    const r = await unsubscribe(target, { all, ip: clientIp(req), ua: req.headers.get("user-agent") });
    return NextResponse.json({ ok: true, withdrawn: r.withdrawn }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    // Never tell the person they are unsubscribed when the ledger write failed.
    console.error("[t/u] unsubscribe failed:", err);
    return NextResponse.json({ error: "internal_error" }, { status: 500, headers: { "Cache-Control": "no-store" } });
  }
}
