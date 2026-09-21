import { NextRequest, NextResponse } from "next/server";
import { requireScope, scopeErrorResponse } from "@/lib/auth/scope";
import { BookingValidationError, ensureDefaultCalendar, listRules, replaceRules } from "@/lib/calendar/booking";
import { query } from "@/lib/dsql";

export const runtime = "nodejs";

/** GET /api/calendar — the org's calendars with their weekly rules. */
export async function GET() {
  try {
    const scope = await requireScope({ area: "calendar" });
    const first = await ensureDefaultCalendar(scope.dataId);
    const calendars = await query<{ id: string; name: string; timezone: string; color: string | null; created_at: string }>(
      `SELECT id, name, timezone, color, created_at FROM calendars WHERE user_id = $1 ORDER BY created_at ASC`,
      [scope.dataId]
    );
    const withRules = await Promise.all(calendars.map(async (c) => ({ ...c, rules: await listRules(c.id) })));
    return NextResponse.json({ calendars: withRules, defaultCalendarId: first.id, canEdit: scope.can("calendar", true) });
  } catch (err) {
    return scopeErrorResponse(err) ?? NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

/** PATCH /api/calendar — { calendarId?, timezone?, name?, rules?: [{weekday,start_minute,end_minute}] } */
export async function PATCH(req: NextRequest) {
  try {
    const scope = await requireScope({ area: "calendar", edit: true });
    const body = (await req.json().catch(() => ({}))) as {
      calendarId?: string;
      timezone?: string;
      name?: string;
      rules?: Array<{ weekday: number; start_minute: number; end_minute: number }>;
    };
    const calendarId = body.calendarId ?? (await ensureDefaultCalendar(scope.dataId)).id;
    const owned = await query<{ id: string }>(`SELECT id FROM calendars WHERE id = $1 AND user_id = $2`, [calendarId, scope.dataId]);
    if (owned.length === 0) return NextResponse.json({ error: "not_found" }, { status: 404 });

    if (typeof body.timezone === "string") {
      try {
        new Intl.DateTimeFormat("en-US", { timeZone: body.timezone });
      } catch {
        return NextResponse.json({ error: "invalid_timezone" }, { status: 400 });
      }
      await query(`UPDATE calendars SET timezone = $3 WHERE id = $1 AND user_id = $2`, [calendarId, scope.dataId, body.timezone]);
    }
    if (typeof body.name === "string" && body.name.trim()) {
      await query(`UPDATE calendars SET name = $3 WHERE id = $1 AND user_id = $2`, [calendarId, scope.dataId, body.name.trim().slice(0, 120)]);
    }
    let rules = await listRules(calendarId);
    if (Array.isArray(body.rules)) {
      if (body.rules.length > 50) return NextResponse.json({ error: "too_many_rules" }, { status: 400 });
      rules = await replaceRules(
        calendarId,
        body.rules.map((r) => ({ weekday: Number(r.weekday), start_minute: Number(r.start_minute), end_minute: Number(r.end_minute) }))
      );
    }
    return NextResponse.json({ ok: true, calendarId, rules });
  } catch (err) {
    if (err instanceof BookingValidationError) return NextResponse.json({ error: err.message }, { status: 400 });
    return scopeErrorResponse(err) ?? NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
