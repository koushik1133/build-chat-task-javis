import { getTaxRate } from "@/lib/money/tax-rates";
import { ROUTES } from "@/lib/public-api/registry";
import { op, mustFind } from "@/lib/public-api/handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = op(ROUTES.getTaxRate, async ({ principal, params }) => ({ data: mustFind(await getTaxRate(principal.dataId, params.id), "Tax rate") }));
