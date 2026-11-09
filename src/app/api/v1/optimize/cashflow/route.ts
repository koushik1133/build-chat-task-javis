import { runCashflow } from "@/lib/optimize";
import { ROUTES } from "@/lib/public-api/registry";
import { op } from "@/lib/public-api/handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = op(ROUTES.optimizeCashflow, async ({ principal, query }) => ({ data: await runCashflow(principal.dataId, { weeks: query.weeks }) }));
