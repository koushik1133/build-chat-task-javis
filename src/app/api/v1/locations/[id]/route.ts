import { getLocation } from "@/lib/inventory/locations";
import { ROUTES } from "@/lib/public-api/registry";
import { op, mustFind } from "@/lib/public-api/handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = op(ROUTES.getLocation, async ({ principal, params }) => ({ data: mustFind(await getLocation(principal.dataId, params.id), "Location") }));
