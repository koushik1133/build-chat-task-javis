import { NextRequest, NextResponse } from "next/server";
import { requireScope, scopeErrorResponse } from "@/lib/auth/scope";
import { BOOKING_COLS, BookingConflictError, BookingValidationError, createBooking, type BookingRow } from "@/lib/calendar/booking";
import { query } from "@/lib/dsql";

export const runtime = "nodejs";

/** GET /api/bookings?from=&to=&status= */
export async function GET(req: NextRequest) {
  try {
    const scope = await requireScope({ area: "calendar" });
    const sp = new URL(req.url).searchParams;
    const from = sp.get("from") ? new Date(sp.get("from") as string) : new Date(Date.now() - 7 * 86_400_000);
    const to = sp.get("to") ? new Date(sp.get("to") as string) : new Date(from.getTime() + 30 * 86_400_000);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return NextResponse.json({ error: "invalid range" }, { status: 400 });
    const params: unknown[] = [scope.dataId, from.toISOString(), to.toISOString()];
    let sql = `SELECT ${BOOKING_COLS} FROM bookings WHERE user_id = $1 AND starts_at < $3 AND ends_at > $2`;
    const status = sp.get("status");
    if (status) {
      params.push(status);
      sql += ` AND status = $${params.length}`;
    }
    sql += ` ORDER BY starts_at ASC LIMIT 500`;
    const bookings = await query<BookingRow>(sql, params);
    return NextResponse.json({ bookings });
  } catch (err) {
    return scopeErrorResponse(err) ?? NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

/** POST /api/bookings — manual booking by staff. */
export async function POST(req: NextRequest) {
  try {
    const scope = await requireScope({ area: "calendar", edit: true });
    const body = (await req.json().catch(() => ({}))) as {
      name?: string;
      email?: string;
      phone?: string;
      startsAt?: string;
      durationMinutes?: number;
      bookingTypeId?: string;
      calendarId?: string;
      contactId?: string;
      notes?: string;
      ignoreRules?: boolean;
    };
    if (!body.name?.trim()) return NextResponse.json({ error: "name is required" }, { status: 400 });
    if (!body.startsAt) return NextResponse.json({ error: "startsAt is required" }, { status: 400 });
    const { booking } = await createBooking(scope.dataId, {
      name: body.name,
      email: body.email ?? null,
      phone: body.phone ?? null,
      startsAt: body.startsAt,
      durationMinutes: body.durationMinutes,
      bookingTypeId: body.bookingTypeId ?? null,
      calendarId: body.calendarId,
      contactId: body.contactId ?? null,
      notes: body.notes ?? null,
      source: "manual",
      ignoreRules: body.ignoreRules !== false,
    });
    return NextResponse.json({ booking }, { status: 201 });
  } catch (err) {
    if (err instanceof BookingConflictError) return NextResponse.json({ error: "conflict", detail: err.message }, { status: 409 });
    if (err instanceof BookingValidationError) return NextResponse.json({ error: err.message }, { status: 400 });
    return scopeErrorResponse(err) ?? NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
