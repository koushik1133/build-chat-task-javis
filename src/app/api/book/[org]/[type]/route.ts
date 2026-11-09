import { NextRequest, NextResponse } from "next/server";
import { rateLimitAsync, readCappedText } from "@/lib/request-limits";
import {
  BookingConflictError,
  BookingValidationError,
  availableSlots,
  createBooking,
  recordBookingConsent,
  getBookingTypeBySlug,
  resolveOrgBySlug,
} from "@/lib/calendar/booking";
import { groupSlotsByDay } from "@/lib/calendar/slots";

export const runtime = "nodejs";
// Slot availability is time-sensitive and public: never cache at any layer.
export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store, max-age=0" } as const;

type Ctx = { params: Promise<{ org: string; type: string }> };

function clientIp(req: NextRequest): string {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || req.headers.get("x-real-ip") || "anon";
}

async function limited(req: NextRequest): Promise<NextResponse | null> {
  const { allowed } = await rateLimitAsync(`book:${clientIp(req)}`, 60, 60_000);
  return allowed ? null : NextResponse.json({ error: "rate_limited" }, { status: 429 });
}

async function resolve(ctx: Ctx) {
  const { org, type } = await ctx.params;
  const o = await resolveOrgBySlug(org);
  if (!o) return null;
  const t = await getBookingTypeBySlug(o.dataId, type);
  if (!t || !t.active) return null;
  return { org: o, type: t };
}

/** GET /api/book/[org]/[type]?from=&to= — booking type + open slots. */
export async function GET(req: NextRequest, ctx: Ctx) {
  const block = await limited(req);
  if (block) return block;
  try {
    const r = await resolve(ctx);
    if (!r) return NextResponse.json({ error: "not_found" }, { status: 404 });
    const sp = new URL(req.url).searchParams;
    const now = new Date();
    const from = sp.get("from") ? new Date(sp.get("from") as string) : now;
    const to = sp.get("to") ? new Date(sp.get("to") as string) : new Date(from.getTime() + 14 * 86_400_000);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return NextResponse.json({ error: "invalid range" }, { status: 400 });
    if (to.getTime() - from.getTime() > 62 * 86_400_000) return NextResponse.json({ error: "range too large" }, { status: 400 });
    const { timezone, slots } = await availableSlots(r.type, from, to, now);
    const t = r.type;
    return NextResponse.json(
      {
        org: { name: r.org.name, slug: r.org.slug },
        type: {
          slug: t.slug,
          name: t.name,
          description: t.description,
          durationMinutes: t.duration_minutes,
          priceMinor: t.price_minor,
          currency: t.currency,
          maxDaysAhead: t.max_days_ahead,
        },
        timezone,
        slots,
      byDay: groupSlotsByDay(slots, timezone),
      },
      { headers: NO_STORE }
    );
  } catch (err) {
    console.error("[book] GET failed:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

/** POST /api/book/[org]/[type] — { name, email, phone?, startsAt, notes? } → 201 | 409 */
export async function POST(req: NextRequest, ctx: Ctx) {
  const block = await limited(req);
  if (block) return block;
  try {
    const r = await resolve(ctx);
    if (!r) return NextResponse.json({ error: "not_found" }, { status: 404 });
    const raw = await readCappedText(req, 8_192);
    if (raw === null) return NextResponse.json({ error: "payload too large" }, { status: 413 });
    let body: { name?: unknown; email?: unknown; phone?: unknown; startsAt?: unknown; notes?: unknown; consent?: unknown } = {};
    try {
      body = JSON.parse(raw || "{}");
    } catch {
      return NextResponse.json({ error: "invalid json" }, { status: 400 });
    }
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const email = typeof body.email === "string" ? body.email.trim() : "";
    if (!name) return NextResponse.json({ error: "name is required" }, { status: 400 });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return NextResponse.json({ error: "a valid email is required" }, { status: 400 });
    if (typeof body.startsAt !== "string") return NextResponse.json({ error: "startsAt is required" }, { status: 400 });

    const created = await createBooking(r.org.dataId, {
      bookingTypeId: r.type.id,
      name,
      email,
      phone: typeof body.phone === "string" ? body.phone : null,
      startsAt: body.startsAt,
      notes: typeof body.notes === "string" ? body.notes : null,
      source: "public",
    });
    const { booking, cancelToken } = created;
    // Optional `consent: { marketing: boolean }` → ledger row on the contact this booking created, else on the booking.
    const consent = body.consent && typeof body.consent === "object" ? (body.consent as Record<string, unknown>) : null;
    if (typeof consent?.marketing === "boolean") {
      void recordBookingConsent(r.org.dataId, created, consent.marketing, { ip: clientIp(req), ua: req.headers.get("user-agent"), text_version: `booking:${r.type.slug}` }).catch(() => undefined);
    }
    return NextResponse.json(
      {
        booking: { id: booking.id, startsAt: booking.starts_at, endsAt: booking.ends_at, status: booking.status },
        cancelPath: `/book/cancel/${cancelToken}`,
      },
      { status: 201 }
    );
  } catch (err) {
    if (err instanceof BookingConflictError) return NextResponse.json({ error: "conflict", detail: err.message }, { status: 409 });
    if (err instanceof BookingValidationError) return NextResponse.json({ error: err.message }, { status: 400 });
    console.error("[book] POST failed:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
