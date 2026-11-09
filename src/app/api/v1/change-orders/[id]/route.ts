import { getChangeOrder } from "@/lib/finance/change-orders";
import { ROUTES } from "@/lib/public-api/registry";
import { op, mustFind } from "@/lib/public-api/handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = op(ROUTES.getChangeOrder, async ({ principal, params }) => ({ data: mustFind(await getChangeOrder(principal.dataId, params.id), "Change order") }));
