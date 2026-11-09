import { listLevels } from "@/lib/inventory/levels";
import { ROUTES } from "@/lib/public-api/registry";
import { op, singlePage } from "@/lib/public-api/handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = op(ROUTES.listStockLevels, async ({ principal, query }) => singlePage(await listLevels(principal.dataId, { productId: query.product ?? null, locationId: query.location ?? null })));
