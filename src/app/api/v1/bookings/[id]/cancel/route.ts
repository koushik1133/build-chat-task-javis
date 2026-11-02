import { cancelBooking } from "@/lib/calendar/booking";
import { ROUTES } from "@/lib/public-api/registry";
import { op, mustFind } from "@/lib/public-api/handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = op(ROUTES.cancelBooking, async ({ principal, params, body }) => ({
  data: mustFind(await cancelBooking(principal.dataId, params.id, body.reason ?? undefined), "Booking"),
}));
