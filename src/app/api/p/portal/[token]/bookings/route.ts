import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { rateLimitAsync } from "@/lib/request-limits";
import { authPortalToken, clientIp } from "@/lib/portal-auth";
import { availableSlots, BookingConflictError, BookingPolicyError, BookingValidationError, getBooking, getBookingType, rescheduleBooking } from "@/lib/calendar/booking";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ token: string }> };

const MAX_RANGE_MS = 31 * 86_400_000;

/** GET /api/p/portal/[token]/bookings?bookingId&from&to → open slots for the same booking type. */
export async function GET(req: NextRequest, ctx: Ctx) {
  if (!(await rateLimitAsync(`portal-slots:${clientIp(req)}`, 60, 60_000)).allowed) return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  try {
    const auth = await authPortalToken((await ctx.params).token);
    if (!auth) return NextResponse.json({ error: "not_found" }, { status: 404 });
    const sp = req.nextUrl.searchParams;
    const bookingId = sp.get("bookingId") ?? "";
    const booking = bookingId ? await getBooking(auth.dataId, bookingId) : null;
    if (!booking || booking.contact_id !== auth.contactId || !booking.booking_type_id) return NextResponse.json({ error: "not_found" }, { status: 404 });
    const type = await getBookingType(auth.dataId, booking.booking_type_id);
    if (!type) return NextResponse.json({ error: "not_found" }, { status: 404 });
    const from = sp.get("from") ? new Date(sp.get("from") as string) : new Date();
    const to = sp.get("to") ? new Date(sp.get("to") as string) : new Date(from.getTime() + 14 * 86_400_000);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to <= from) return NextResponse.json({ error: "invalid_range" }, { status: 400 });
    const cappedTo = new Date(Math.min(to.getTime(), from.getTime() + MAX_RANGE_MS));
    const { timezone, slots } = await availableSlots(type, from, cappedTo);
    return NextResponse.json({ timezone, durationMinutes: type.duration_minutes, slots });
  } catch (err) {
    console.error("[portal] slots failed:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

const Body = z.object({ bookingId: z.string().min(1).max(80), startsAt: z.string().min(10).max(40) }).strict();

/** POST /api/p/portal/[token]/bookings — reschedule { bookingId, startsAt }. 409 on clash, 403 inside the change window. */
export async function POST(req: NextRequest, ctx: Ctx) {
  if (!(await rateLimitAsync(`portal-resched:${clientIp(req)}`, 20, 60_000)).allowed) return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  try {
    const auth = await authPortalToken((await ctx.params).token);
    if (!auth) return NextResponse.json({ error: "not_found" }, { status: 404 });
    const parsed = Body.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: "invalid_request" }, { status: 400 });
    const booking = await getBooking(auth.dataId, parsed.data.bookingId);
    if (!booking || booking.contact_id !== auth.contactId) return NextResponse.json({ error: "not_found" }, { status: 404 });
    try {
      const updated = await rescheduleBooking(auth.dataId, booking.id, parsed.data.startsAt, "contact");
      return NextResponse.json({ ok: true, booking: { id: updated.id, status: updated.status, startsAt: updated.starts_at, endsAt: updated.ends_at } });
    } catch (err) {
      if (err instanceof BookingConflictError) return NextResponse.json({ error: "slot_unavailable", message: err.message }, { status: 409 });
      if (err instanceof BookingPolicyError) return NextResponse.json({ error: "outside_change_window", message: err.message }, { status: 403 });
      if (err instanceof BookingValidationError) return NextResponse.json({ error: "invalid_request", message: err.message }, { status: 400 });
      throw err;
    }
  } catch (err) {
    console.error("[portal] reschedule failed:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
