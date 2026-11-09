import { getTransfer } from "@/lib/inventory/transfers";
import { ROUTES } from "@/lib/public-api/registry";
import { op, mustFind } from "@/lib/public-api/handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = op(ROUTES.getTransfer, async ({ principal, params }) => ({ data: mustFind(await getTransfer(principal.dataId, params.id), "Transfer") }));
