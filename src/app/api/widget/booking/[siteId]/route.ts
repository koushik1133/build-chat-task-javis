import { NextRequest } from "next/server";
import { z } from "zod";
import { BookingConflictError, BookingValidationError, availableSlots, createBooking, getBookingTypeBySlug, listBookingTypes, recordBookingConsent } from "@/lib/calendar/booking";
import { groupSlotsByDay } from "@/lib/calendar/slots";
import { loadSiteForWidget } from "@/lib/webchat/public-config";
import { clientIp, enforceLimits, isUuid, jsonWith, parseBody, widgetCors, widgetPreflight } from "@/lib/webchat/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ siteId: string }> };

export async function OPTIONS(req: NextRequest, { params }: Ctx) {
  return widgetPreflight(req, (await params).siteId);
}

/** GET ?type=<slug>&from=&to= — booking types (no type) or open slots for one type. CORS-enabled proxy over the public booking API. */
export async function GET(req: NextRequest, { params }: Ctx) {
  const { siteId } = await params;
  const cors = await widgetCors(req, siteId);
  try {
    if (!isUuid(siteId)) return jsonWith(cors, { error: "not_found" }, 404);
    const limited = await enforceLimits(cors, [{ key: `widget:book:${clientIp(req)}`, limit: 60, windowMs: 60_000 }]);
    if (limited) return limited;
    const site = await loadSiteForWidget(siteId);
    if (!site) return jsonWith(cors, { error: "not_found" }, 404);
    const sp = new URL(req.url).searchParams;
    const slug = sp.get("type");
    if (!slug) {
      const types = await listBookingTypes(site.user_id, { activeOnly: true });
      return jsonWith(cors, { types: types.map((t) => ({ slug: t.slug, name: t.name, description: t.description, durationMinutes: t.duration_minutes, priceMinor: t.price_minor, currency: t.currency })) });
    }
    const type = await getBookingTypeBySlug(site.user_id, slug);
    if (!type || !type.active) return jsonWith(cors, { error: "not_found" }, 404);
    const now = new Date();
    const from = sp.get("from") ? new Date(sp.get("from") as string) : now;
    const to = sp.get("to") ? new Date(sp.get("to") as string) : new Date(from.getTime() + 14 * 86_400_000);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return jsonWith(cors, { error: "invalid_range" }, 400);
    if (to.getTime() - from.getTime() > 62 * 86_400_000) return jsonWith(cors, { error: "range_too_large" }, 400);
    const { timezone, slots } = await availableSlots(type, from, to, now);
    return jsonWith(cors, { type: { slug: type.slug, name: type.name, durationMinutes: type.duration_minutes }, timezone, slots, byDay: groupSlotsByDay(slots, timezone) }, 200, { "Cache-Control": "no-store" });
  } catch (err) {
    console.error("[widget] booking GET failed:", err);
    return jsonWith(cors, { error: "internal" }, 500);
  }
}

const BookSchema = z
  .object({
    type: z.string().min(1).max(120),
    name: z.string().trim().min(1).max(120),
    email: z.string().trim().email().max(200),
    phone: z.string().trim().max(40).optional(),
    startsAt: z.string().min(10).max(40),
    notes: z.string().trim().max(2000).optional(),
    consent: z.object({ marketing: z.boolean() }).strict().optional(),
  })
  .strict();

/** POST — book a slot inline from the widget. */
export async function POST(req: NextRequest, { params }: Ctx) {
  const { siteId } = await params;
  const cors = await widgetCors(req, siteId);
  try {
    if (!isUuid(siteId)) return jsonWith(cors, { error: "not_found" }, 404);
    const ip = clientIp(req);
    const limited = await enforceLimits(cors, [{ key: `widget:book:post:${ip}`, limit: 10, windowMs: 60 * 60 * 1000 }]);
    if (limited) return limited;
    const site = await loadSiteForWidget(siteId);
    if (!site) return jsonWith(cors, { error: "not_found" }, 404);
    const body = await parseBody(req, BookSchema, cors, 8_192);
    if ("res" in body) return body.res;
    const type = await getBookingTypeBySlug(site.user_id, body.data.type);
    if (!type || !type.active) return jsonWith(cors, { error: "not_found" }, 404);

    const created = await createBooking(site.user_id, {
      bookingTypeId: type.id,
      name: body.data.name,
      email: body.data.email,
      phone: body.data.phone ?? null,
      startsAt: body.data.startsAt,
      notes: body.data.notes ?? null,
      source: "public",
    });
    const { booking, cancelToken } = created;
    if (body.data.consent) {
      void recordBookingConsent(site.user_id, created, body.data.consent.marketing, { ip, ua: req.headers.get("user-agent"), text_version: `site:${siteId}` }).catch(() => undefined);
    }
    return jsonWith(cors, { booking: { id: booking.id, startsAt: booking.starts_at, endsAt: booking.ends_at, status: booking.status }, cancelPath: `/book/cancel/${cancelToken}` }, 201);
  } catch (err) {
    if (err instanceof BookingConflictError) return jsonWith(cors, { error: "conflict", detail: err.message }, 409);
    if (err instanceof BookingValidationError) return jsonWith(cors, { error: err.message }, 400);
    console.error("[widget] booking POST failed:", err);
    return jsonWith(cors, { error: "internal" }, 500);
  }
}
