import { getSavedReport } from "@/lib/reports/store";
import { resolveDataset, runReport } from "@/lib/reports/query";
import { ROUTES } from "@/lib/public-api/registry";
import { libCall, mustFind, op } from "@/lib/public-api/handler";
import { ApiError } from "@/lib/public-api/envelope";
import { hasScope, readScope } from "@/lib/public-api/scopes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = op(ROUTES.runSavedReport, async ({ principal, params }) => {
  const report = mustFind(await getSavedReport(principal.dataId, principal.userId, params.id), "Report");
  // Same gate as the in-app route: a reports-only key must not read billing/agents/team datasets.
  const dataset = mustFind(await resolveDataset(principal.dataId, report.spec.dataset), "Dataset");
  if (!hasScope(principal.scopes, readScope(dataset.area))) throw ApiError.forbidden(`This key lacks the "${readScope(dataset.area)}" scope needed for the ${dataset.key} dataset`);
  const result = await libCall(() => runReport(principal.dataId, report.spec, { dataset }));
  return { data: { report, result } };
});
