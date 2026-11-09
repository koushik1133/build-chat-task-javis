import { listLocations } from "@/lib/inventory/locations";
import { ROUTES } from "@/lib/public-api/registry";
import { op, singlePage } from "@/lib/public-api/handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = op(ROUTES.listLocations, async ({ principal, query }) => singlePage(await listLocations(principal.dataId, { includeInactive: query.include_inactive === "true" })));
