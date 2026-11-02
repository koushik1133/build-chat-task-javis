import { getBooking } from "@/lib/calendar/booking";
import { ROUTES } from "@/lib/public-api/registry";
import { op, mustFind } from "@/lib/public-api/handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = op(ROUTES.getBooking, async ({ principal, params }) => ({ data: mustFind(await getBooking(principal.dataId, params.id), "Booking") }));
