import { NextRequest, NextResponse } from "next/server";
import { rateLimitAsync } from "@/lib/request-limits";
import { resolveShareToken } from "@/lib/share-tokens";
import { getPortalData } from "@/lib/portal";
import { bookingChangeWindowHours, cancelBooking, getBooking } from "@/lib/calendar/booking";
import { withinChangeWindow } from "@/lib/portal-rules";
import { clientIp } from "@/lib/portal-auth";
import { withRequestContext } from "@/lib/log/context";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ token: string }> };

const ip = (req: NextRequest): string => clientIp(req);

/** GET /api/p/portal/[token] — the client's portal data. */
async function getHandler(req: NextRequest, ctx: Ctx) {
  if (!(await rateLimitAsync(`portal:${ip(req)}`, 60, 60_000)).allowed) return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  try {
    const { token } = await ctx.params;
    const t = await resolveShareToken("portal", token);
    if (!t) return NextResponse.json({ error: "not_found" }, { status: 404 });
    // Each load mints order/sign links; cap minting per portal contact so a looping client cannot bloat share_tokens.
    const mint = (await rateLimitAsync(`portal-mint:${t.user_id}:${t.entity_id}`, 12, 3_600_000)).allowed;
    const data = await getPortalData(t.user_id, t.entity_id, { issueLinks: mint });
    if (!data) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json(data);
  } catch (err) {
    console.error("[portal] GET failed:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

/** POST /api/p/portal/[token] — { action: "cancel_booking", bookingId } */
async function postHandler(req: NextRequest, ctx: Ctx) {
  if (!(await rateLimitAsync(`portal:${ip(req)}`, 60, 60_000)).allowed) return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  try {
    const { token } = await ctx.params;
    const t = await resolveShareToken("portal", token);
    if (!t) return NextResponse.json({ error: "not_found" }, { status: 404 });
    const body = (await req.json().catch(() => ({}))) as { action?: string; bookingId?: string };
    if (body.action !== "cancel_booking" || !body.bookingId) return NextResponse.json({ error: "unsupported action" }, { status: 400 });
    const booking = await getBooking(t.user_id, body.bookingId);
    if (!booking || booking.contact_id !== t.entity_id) return NextResponse.json({ error: "not_found" }, { status: 404 });
    if (booking.status !== "cancelled") {
      const hours = await bookingChangeWindowHours(t.user_id);
      if (!withinChangeWindow(booking.starts_at, hours)) {
        return NextResponse.json({ error: "outside_change_window", message: `Appointments can only be cancelled at least ${hours} hours in advance. Please contact us directly.` }, { status: 403 });
      }
    }
    const updated = await cancelBooking(t.user_id, booking.id, "Cancelled via client portal");
    return NextResponse.json({ ok: true, booking: { id: booking.id, status: updated?.status ?? "cancelled" } });
  } catch (err) {
    console.error("[portal] POST failed:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

export const GET = withRequestContext(getHandler);
export const POST = withRequestContext(postHandler);
