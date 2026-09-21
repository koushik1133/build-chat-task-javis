import { randomUUID } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { requireScope, scopeErrorResponse } from "@/lib/auth/scope";
import { BOOKING_TYPE_COLS, ensureDefaultCalendar, type BookingTypeRow } from "@/lib/calendar/booking";
import { query, queryOne } from "@/lib/dsql";
import { intField, readTypeBody, slugifyType } from "@/lib/calendar/booking-types";

export const runtime = "nodejs";

export async function GET() {
  try {
    const scope = await requireScope({ area: "calendar" });
    const types = await query<BookingTypeRow>(
      `SELECT ${BOOKING_TYPE_COLS} FROM booking_types WHERE user_id = $1 ORDER BY created_at ASC`,
      [scope.dataId]
    );
    return NextResponse.json({ types, orgSlug: scope.orgSlug });
  } catch (err) {
    return scopeErrorResponse(err) ?? NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const scope = await requireScope({ area: "calendar", edit: true });
    const body = readTypeBody(await req.json().catch(() => ({})));
    const name = typeof body.name === "string" ? body.name.trim().slice(0, 120) : "";
    if (!name) return NextResponse.json({ error: "name is required" }, { status: 400 });
    const slug = slugifyType(typeof body.slug === "string" && body.slug.trim() ? body.slug : name) || `type-${randomUUID().slice(0, 6)}`;
    const dup = await queryOne<{ id: string }>(`SELECT id FROM booking_types WHERE user_id = $1 AND slug = $2`, [scope.dataId, slug]);
    if (dup) return NextResponse.json({ error: "slug_taken" }, { status: 409 });

    const calendarId = typeof body.calendar_id === "string" && body.calendar_id ? body.calendar_id : (await ensureDefaultCalendar(scope.dataId)).id;
    const owned = await queryOne<{ id: string }>(`SELECT id FROM calendars WHERE id = $1 AND user_id = $2`, [calendarId, scope.dataId]);
    if (!owned) return NextResponse.json({ error: "unknown calendar" }, { status: 400 });

    const id = randomUUID();
    await query(
      `INSERT INTO booking_types (id, user_id, calendar_id, slug, name, description, duration_minutes, buffer_before, buffer_after, min_notice_minutes, max_days_ahead, price_minor, currency, active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      [
        id,
        scope.dataId,
        calendarId,
        slug,
        name,
        typeof body.description === "string" ? body.description.trim().slice(0, 2000) || null : null,
        intField(body.duration_minutes, 30, 5, 24 * 60),
        intField(body.buffer_before, 0, 0, 240),
        intField(body.buffer_after, 0, 0, 240),
        intField(body.min_notice_minutes, 60, 0, 60 * 24 * 30),
        intField(body.max_days_ahead, 30, 1, 365),
        body.price_minor == null || body.price_minor === "" ? null : intField(body.price_minor, 0, 0, 1_000_000_000),
        typeof body.currency === "string" && body.currency.trim() ? body.currency.trim().toUpperCase().slice(0, 3) : null,
        body.active === undefined ? true : Boolean(body.active),
      ]
    );
    const row = await queryOne<BookingTypeRow>(`SELECT ${BOOKING_TYPE_COLS} FROM booking_types WHERE id = $1`, [id]);
    return NextResponse.json({ type: row, publicPath: `/book/${scope.orgSlug}/${slug}` }, { status: 201 });
  } catch (err) {
    return scopeErrorResponse(err) ?? NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
