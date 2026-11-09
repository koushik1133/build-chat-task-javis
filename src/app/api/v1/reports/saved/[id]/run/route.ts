import { getSavedReport } from "@/lib/reports/store";
import { runReport } from "@/lib/reports/query";
import { ROUTES } from "@/lib/public-api/registry";
import { libCall, mustFind, op } from "@/lib/public-api/handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = op(ROUTES.runSavedReport, async ({ principal, params }) => {
  const report = mustFind(await getSavedReport(principal.dataId, principal.userId, params.id), "Report");
  const result = await libCall(() => runReport(principal.dataId, report.spec));
  return { data: { report, result } };
});
