import { getSavedReport } from "@/lib/reports/store";
import { ROUTES } from "@/lib/public-api/registry";
import { mustFind, op } from "@/lib/public-api/handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = op(ROUTES.getSavedReport, async ({ principal, params }) => ({ data: mustFind(await getSavedReport(principal.dataId, principal.userId, params.id), "Report") }));
