import { NextResponse, type NextRequest } from "next/server";
import { clientIp, rateLimitAsync, readCappedText } from "@/lib/request-limits";
import { resolveShareToken } from "@/lib/share-tokens";
import { withRequestContext } from "@/lib/log/context";
import { MembershipError } from "@/lib/memberships/plans";
import { PortalActionSchema, portalMemberships, runPortalAction } from "@/lib/memberships/portal";
import { logger } from "@/lib/log/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ token: string }> };
const NO_STORE = { "Cache-Control": "no-store, max-age=0" } as const;

/** GET /api/p/portal/[token]/memberships — the portal contact's memberships. */
async function getHandler(req: NextRequest, ctx: Ctx) {
  if (!(await rateLimitAsync(`portal:${clientIp(req)}`, 60, 60_000)).allowed) return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  try {
    const { token } = await ctx.params;
    const t = await resolveShareToken("portal", token);
    if (!t) return NextResponse.json({ error: "not_found" }, { status: 404 });
    const mint = (await rateLimitAsync(`portal-mint:${t.user_id}:${t.entity_id}`, 12, 3_600_000)).allowed;
    return NextResponse.json({ memberships: await portalMemberships(t.user_id, t.entity_id, { issueLinks: mint }) }, { headers: NO_STORE });
  } catch (err) {
    logger.error("portal memberships GET failed", { err: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

/** POST — { action: cancel|keep|pause|resume|update_payment_method, subscription_id, until?, simulate? } */
async function postHandler(req: NextRequest, ctx: Ctx) {
  if (!(await rateLimitAsync(`portal:${clientIp(req)}`, 60, 60_000)).allowed) return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  try {
    const { token } = await ctx.params;
    const t = await resolveShareToken("portal", token);
    if (!t) return NextResponse.json({ error: "not_found" }, { status: 404 });
    const text = await readCappedText(req, 4_096);
    if (text === null) return NextResponse.json({ error: "payload_too_large" }, { status: 413 });
    let json: unknown;
    try {
      json = JSON.parse(text || "{}");
    } catch {
      return NextResponse.json({ error: "invalid_json" }, { status: 400 });
    }
    const parsed = PortalActionSchema.safeParse(json);
    if (!parsed.success) return NextResponse.json({ error: "invalid_body", detail: parsed.error.flatten() }, { status: 400 });
    await runPortalAction(t.user_id, t.entity_id, parsed.data);
    return NextResponse.json({ ok: true, memberships: await portalMemberships(t.user_id, t.entity_id, { issueLinks: false }) }, { headers: NO_STORE });
  } catch (err) {
    if (err instanceof MembershipError) return NextResponse.json({ error: err.code, message: err.message }, { status: err.status });
    logger.error("portal memberships POST failed", { err: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

export const GET = withRequestContext(getHandler);
export const POST = withRequestContext(postHandler);
