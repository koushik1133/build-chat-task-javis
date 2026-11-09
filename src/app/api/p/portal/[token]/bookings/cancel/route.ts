import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { rateLimitAsync } from "@/lib/request-limits";
import { authPortalToken, clientIp } from "@/lib/portal-auth";
import { bookingChangeWindowHours, cancelBooking, getBooking } from "@/lib/calendar/booking";
import { withinChangeWindow } from "@/lib/portal-rules";

export const runtime = "nodejs";

const Body = z.object({ bookingId: z.string().min(1).max(80), reason: z.string().trim().max(500).optional() }).strict();

/** POST /api/p/portal/[token]/bookings/cancel — { bookingId }. 403 inside the org's change window. */
export async function POST(req: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  if (!(await rateLimitAsync(`portal-cancel:${clientIp(req)}`, 20, 60_000)).allowed) return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  try {
    const auth = await authPortalToken((await ctx.params).token);
    if (!auth) return NextResponse.json({ error: "not_found" }, { status: 404 });
    const parsed = Body.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: "invalid_request" }, { status: 400 });
    const booking = await getBooking(auth.dataId, parsed.data.bookingId);
    if (!booking || booking.contact_id !== auth.contactId) return NextResponse.json({ error: "not_found" }, { status: 404 });
    if (booking.status !== "cancelled") {
      const hours = await bookingChangeWindowHours(auth.dataId);
      if (!withinChangeWindow(booking.starts_at, hours)) {
        return NextResponse.json({ error: "outside_change_window", message: `Appointments can only be cancelled at least ${hours} hours in advance. Please contact us directly.` }, { status: 403 });
      }
    }
    const updated = await cancelBooking(auth.dataId, booking.id, parsed.data.reason ? `Cancelled via client portal: ${parsed.data.reason}` : "Cancelled via client portal");
    return NextResponse.json({ ok: true, booking: { id: booking.id, status: updated?.status ?? "cancelled" } });
  } catch (err) {
    console.error("[portal] cancel failed:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
