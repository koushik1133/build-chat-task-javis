import { NextRequest, NextResponse } from "next/server";
import { requireScope, scopeErrorResponse } from "@/lib/auth/scope";
import { cancelBooking, getBooking, setBookingStatus } from "@/lib/calendar/booking";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, ctx: Ctx) {
  try {
    const scope = await requireScope({ area: "calendar" });
    const { id } = await ctx.params;
    const booking = await getBooking(scope.dataId, id);
    if (!booking) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ booking });
  } catch (err) {
    return scopeErrorResponse(err) ?? NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

/** PATCH /api/bookings/[id] — { action: "cancel" | "complete" | "no_show", reason? } */
export async function PATCH(req: NextRequest, ctx: Ctx) {
  try {
    const scope = await requireScope({ area: "calendar", edit: true });
    const { id } = await ctx.params;
    const body = (await req.json().catch(() => ({}))) as { action?: string; status?: string; reason?: string };
    const action = body.action ?? body.status;
    let booking = null;
    if (action === "cancel" || action === "cancelled") booking = await cancelBooking(scope.dataId, id, body.reason);
    else if (action === "complete" || action === "completed") booking = await setBookingStatus(scope.dataId, id, "completed");
    else if (action === "no_show") booking = await setBookingStatus(scope.dataId, id, "no_show");
    else return NextResponse.json({ error: "action must be cancel, complete or no_show" }, { status: 400 });
    if (!booking) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ booking });
  } catch (err) {
    return scopeErrorResponse(err) ?? NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
