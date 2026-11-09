import { buildPlanSummary } from "@/lib/plans/entitlements";
import { ROUTES } from "@/lib/public-api/registry";
import { op } from "@/lib/public-api/handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = op(ROUTES.getUsage, async ({ principal }) => {
  const s = await buildPlanSummary(principal.dataId);
  return {
    data: {
      plan: s.entitlements.plan,
      status: s.entitlements.status,
      enforced: s.enforced,
      trial_ends_at: s.entitlements.trial.endsAt,
      limits: s.entitlements.limits,
      features: s.entitlements.features,
      usage: Object.fromEntries(s.usage.map((u) => [u.metric, u.used])),
    },
  };
});
