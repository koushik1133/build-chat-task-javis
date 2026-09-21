import { NextRequest, NextResponse } from "next/server";
import { rateLimit } from "@/lib/request-limits";
import { resolveShareToken } from "@/lib/share-tokens";
import { getPortalData } from "@/lib/portal";
import { cancelBooking, getBooking } from "@/lib/calendar/booking";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ token: string }> };

function ip(req: NextRequest): string {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "anon";
}

/** GET /api/p/portal/[token] — the client's portal data. */
export async function GET(req: NextRequest, ctx: Ctx) {
  if (!rateLimit(`portal:${ip(req)}`, 60, 60_000).allowed) return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  try {
    const { token } = await ctx.params;
    const t = await resolveShareToken("portal", token);
    if (!t) return NextResponse.json({ error: "not_found" }, { status: 404 });
    const data = await getPortalData(t.user_id, t.entity_id, { issueLinks: true });
    if (!data) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json(data);
  } catch (err) {
    console.error("[portal] GET failed:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

/** POST /api/p/portal/[token] — { action: "cancel_booking", bookingId } */
export async function POST(req: NextRequest, ctx: Ctx) {
  if (!rateLimit(`portal:${ip(req)}`, 60, 60_000).allowed) return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  try {
    const { token } = await ctx.params;
    const t = await resolveShareToken("portal", token);
    if (!t) return NextResponse.json({ error: "not_found" }, { status: 404 });
    const body = (await req.json().catch(() => ({}))) as { action?: string; bookingId?: string };
    if (body.action !== "cancel_booking" || !body.bookingId) return NextResponse.json({ error: "unsupported action" }, { status: 400 });
    const booking = await getBooking(t.user_id, body.bookingId);
    if (!booking || booking.contact_id !== t.entity_id) return NextResponse.json({ error: "not_found" }, { status: 404 });
    const updated = await cancelBooking(t.user_id, booking.id, "Cancelled via client portal");
    return NextResponse.json({ ok: true, booking: { id: booking.id, status: updated?.status ?? "cancelled" } });
  } catch (err) {
    console.error("[portal] POST failed:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
