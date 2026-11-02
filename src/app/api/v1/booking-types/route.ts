import { listBookingTypes } from "@/lib/calendar/booking";
import { ROUTES } from "@/lib/public-api/registry";
import { op } from "@/lib/public-api/handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = op(ROUTES.listBookingTypes, async ({ principal }) => ({ data: await listBookingTypes(principal.dataId), meta: { next_cursor: null } }));
