import { NextResponse, type NextRequest } from "next/server";
import { query } from "@/lib/dsql";
import { publicRateLimit } from "@/lib/money/http";
import { resolveShareToken } from "@/lib/share-tokens";
import { bookingSummary, buildIcs } from "@/lib/calsync/ics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/calendar/feed/[token]: RFC 5545 feed of upcoming bookings (recently cancelled ones carry STATUS:CANCELLED so subscribers drop them). Titles carry the customer's first name only. */
export async function GET(req: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  const limited = await publicRateLimit(req, "calfeed", 60);
  if (limited) return limited;
  try {
    const share = await resolveShareToken("calfeed", (await ctx.params).token);
    if (!share) return NextResponse.json({ error: "not_found" }, { status: 404 });
    const calendarId = share.entity_id.startsWith("cal:") ? share.entity_id.split(":")[2] ?? null : null;
    const rows = await query<{ id: string; name: string; starts_at: string; ends_at: string; status: string; updated_at: string | null }>(
      `SELECT id, name, starts_at, ends_at, status, updated_at FROM bookings
        WHERE user_id = $1 AND (status IN ('confirmed','completed') OR (status = 'cancelled' AND updated_at > NOW() - INTERVAL '14 days')) AND ends_at > NOW() - INTERVAL '1 day' AND starts_at < NOW() + INTERVAL '180 days'
          AND ($2::text IS NULL OR calendar_id = $2)
        ORDER BY starts_at ASC LIMIT 1000`,
      [share.user_id, calendarId]
    );
    const body = buildIcs(
      rows.map((r) => ({ id: r.id, summary: bookingSummary(r.name), startsAt: r.starts_at, endsAt: r.ends_at, updatedAt: r.updated_at, status: r.status === "cancelled" ? "cancelled" as const : "confirmed" as const })),
      { name: "KernelHub bookings" }
    );
    return new NextResponse(body, { status: 200, headers: { "Content-Type": "text/calendar; charset=utf-8", "Content-Disposition": 'inline; filename="kernelhub.ics"', "Cache-Control": "private, max-age=300" } });
  } catch (err) {
    console.error("[calendar.feed.GET]", err);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
