import { NextRequest, NextResponse } from "next/server";
import { requireScope, scopeErrorResponse } from "@/lib/auth/scope";
import { BOOKING_TYPE_COLS, getBookingType, type BookingTypeRow } from "@/lib/calendar/booking";
import { query, queryOne } from "@/lib/dsql";
import { intField, readTypeBody, slugifyType } from "@/lib/calendar/booking-types";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

export async function PATCH(req: NextRequest, ctx: Ctx) {
  try {
    const scope = await requireScope({ area: "calendar", edit: true });
    const { id } = await ctx.params;
    const existing = await getBookingType(scope.dataId, id);
    if (!existing) return NextResponse.json({ error: "not_found" }, { status: 404 });
    const body = readTypeBody(await req.json().catch(() => ({})));

    const sets: string[] = [];
    const params: unknown[] = [scope.dataId, id];
    const set = (col: string, v: unknown) => {
      params.push(v);
      sets.push(`${col} = $${params.length}`);
    };
    if (typeof body.name === "string" && body.name.trim()) set("name", body.name.trim().slice(0, 120));
    if (typeof body.slug === "string" && body.slug.trim()) {
      const slug = slugifyType(body.slug);
      if (!slug) return NextResponse.json({ error: "invalid slug" }, { status: 400 });
      const dup = await queryOne<{ id: string }>(`SELECT id FROM booking_types WHERE user_id = $1 AND slug = $2 AND id <> $3`, [scope.dataId, slug, id]);
      if (dup) return NextResponse.json({ error: "slug_taken" }, { status: 409 });
      set("slug", slug);
    }
    if (body.description !== undefined) set("description", typeof body.description === "string" ? body.description.trim().slice(0, 2000) || null : null);
    if (body.duration_minutes !== undefined) set("duration_minutes", intField(body.duration_minutes, existing.duration_minutes, 5, 24 * 60));
    if (body.buffer_before !== undefined) set("buffer_before", intField(body.buffer_before, existing.buffer_before, 0, 240));
    if (body.buffer_after !== undefined) set("buffer_after", intField(body.buffer_after, existing.buffer_after, 0, 240));
    if (body.min_notice_minutes !== undefined) set("min_notice_minutes", intField(body.min_notice_minutes, existing.min_notice_minutes, 0, 60 * 24 * 30));
    if (body.max_days_ahead !== undefined) set("max_days_ahead", intField(body.max_days_ahead, existing.max_days_ahead, 1, 365));
    if (body.price_minor !== undefined) set("price_minor", body.price_minor === null || body.price_minor === "" ? null : intField(body.price_minor, 0, 0, 1_000_000_000));
    if (body.currency !== undefined) set("currency", typeof body.currency === "string" && body.currency.trim() ? body.currency.trim().toUpperCase().slice(0, 3) : null);
    if (body.active !== undefined) set("active", Boolean(body.active));
    if (typeof body.calendar_id === "string" && body.calendar_id) {
      const owned = await queryOne<{ id: string }>(`SELECT id FROM calendars WHERE id = $1 AND user_id = $2`, [body.calendar_id, scope.dataId]);
      if (!owned) return NextResponse.json({ error: "unknown calendar" }, { status: 400 });
      set("calendar_id", body.calendar_id);
    }
    if (sets.length > 0) {
      await query(`UPDATE booking_types SET ${sets.join(", ")} WHERE user_id = $1 AND id = $2`, params);
    }
    const row = await queryOne<BookingTypeRow>(`SELECT ${BOOKING_TYPE_COLS} FROM booking_types WHERE id = $1`, [id]);
    return NextResponse.json({ type: row });
  } catch (err) {
    return scopeErrorResponse(err) ?? NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function DELETE(_req: NextRequest, ctx: Ctx) {
  try {
    const scope = await requireScope({ area: "calendar", edit: true });
    const { id } = await ctx.params;
    await query(`DELETE FROM booking_types WHERE user_id = $1 AND id = $2`, [scope.dataId, id]);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return scopeErrorResponse(err) ?? NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
