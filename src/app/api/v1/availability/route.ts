import { availableSlots, getBookingType } from "@/lib/calendar/booking";
import { ROUTES } from "@/lib/public-api/registry";
import { ApiError } from "@/lib/public-api/envelope";
import { op, mustFind } from "@/lib/public-api/handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_RANGE_MS = 60 * 86_400_000;

export const GET = op(ROUTES.availability, async ({ principal, query }) => {
  const type = mustFind(await getBookingType(principal.dataId, query.booking_type_id), "Booking type");
  const from = query.from ? new Date(query.from) : new Date();
  const to = query.to ? new Date(query.to) : new Date(from.getTime() + 14 * 86_400_000);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) throw ApiError.validation([{ in: "query", path: "from/to", message: "must be ISO-8601 dates" }]);
  if (to <= from) throw ApiError.validation([{ in: "query", path: "to", message: "must be after from" }]);
  if (to.getTime() - from.getTime() > MAX_RANGE_MS) throw ApiError.validation([{ in: "query", path: "to", message: "range may not exceed 60 days" }]);
  return { data: await availableSlots(type, from, to) };
});
