import { getShift } from "@/lib/workforce/shifts";
import { ROUTES } from "@/lib/public-api/registry";
import { op, mustFind } from "@/lib/public-api/handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = op(ROUTES.getShift, async ({ principal, params }) => ({ data: mustFind(await getShift(principal.dataId, params.id), "Shift") }));
