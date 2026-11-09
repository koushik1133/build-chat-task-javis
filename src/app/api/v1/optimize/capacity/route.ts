import { runCapacity } from "@/lib/optimize";
import { ROUTES } from "@/lib/public-api/registry";
import { op } from "@/lib/public-api/handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = op(ROUTES.optimizeCapacity, async ({ principal, query }) => ({
  data: await runCapacity(principal.dataId, { weeks: query.weeks, lookbackWeeks: query.lookback_weeks, target: query.target }),
}));
