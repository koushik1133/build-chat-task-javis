import { ROUTES } from "@/lib/public-api/registry";
import { op } from "@/lib/public-api/handler";
import { ApiError } from "@/lib/public-api/envelope";
import { assertFeature } from "@/lib/plans/enforce";
import { isPlanLimitError } from "@/lib/plans/enforce";
import { loadReport } from "@/lib/tax-compliance/reports-data";
import { getTaxProfile } from "@/lib/tax-compliance/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = op(ROUTES.getTaxReport, async ({ principal, query }) => {
  try {
    await assertFeature({ dataId: principal.dataId }, "tax_compliance");
  } catch (e) {
    if (isPlanLimitError(e)) throw new ApiError(403, "forbidden", "Tax reports are not included in your plan");
    throw e;
  }
  if (query.from > query.to) throw new ApiError(400, "validation_failed", "`from` must not be after `to`");
  const profile = await getTaxProfile(principal.dataId);
  const regime = query.regime ?? profile?.regime ?? "generic";
  return { data: await loadReport(principal.dataId, regime, query.from, query.to, profile) };
});
