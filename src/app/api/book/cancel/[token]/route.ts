import { clientIp as trustedClientIp } from "@/lib/request-limits";
import { NextRequest, NextResponse } from "next/server";
import { rateLimitAsync } from "@/lib/request-limits";
import { cancelBookingByToken } from "@/lib/calendar/booking";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ token: string }> };

/** POST /api/book/cancel/[token] — customer self-cancel. */
export async function POST(req: NextRequest, ctx: Ctx) {
  const ip = trustedClientIp(req);
  if (!(await rateLimitAsync(`book-cancel:${ip}`, 60, 60_000)).allowed) return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  try {
    const { token } = await ctx.params;
    if (!token || token.length > 128) return NextResponse.json({ error: "not_found" }, { status: 404 });
    const booking = await cancelBookingByToken(token);
    if (!booking) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ ok: true, booking: { id: booking.id, startsAt: booking.starts_at, status: booking.status } });
  } catch (err) {
    console.error("[book/cancel] failed:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
