import { runPricing } from "@/lib/optimize";
import { ROUTES } from "@/lib/public-api/registry";
import { op } from "@/lib/public-api/handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = op(ROUTES.optimizePricing, async ({ principal, body }) => ({ data: await runPricing(principal.dataId, body.items) }));
