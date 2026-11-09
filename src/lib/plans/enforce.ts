import { type FeatureKey, type Metric, type PlanKey, FEATURE_LABEL, METRIC_LABEL, suggestFeaturePlan } from "./catalog";
import { checkLimit, getEntitlements, plansEnforced } from "./entitlements";

/**
 * Enforcement helpers. Both are no-ops unless PLANS_ENFORCED=true, and fail
 * open when the billing tables cannot be read (never lock an org out because
 * of an infrastructure problem).
 */

export class PlanLimitError extends Error {
  constructor(
    public readonly kind: "limit" | "feature",
    public readonly metric: string,
    public readonly limit: number | null,
    public readonly used: number,
    public readonly upgradeTo: PlanKey | null,
    message: string
  ) {
    super(message);
    this.name = "PlanLimitError";
  }
}

export function upgradeUrl(upgradeTo?: PlanKey | null): string {
  return upgradeTo ? `/settings/plan?upgrade=${upgradeTo}` : "/settings/plan";
}

export function isPlanLimitError(err: unknown): err is PlanLimitError {
  return err instanceof PlanLimitError || (err instanceof Error && err.name === "PlanLimitError");
}

type ScopeLike = { dataId: string };

export async function assertFeature(scope: ScopeLike, feature: FeatureKey): Promise<void> {
  if (!plansEnforced()) return;
  let ent;
  try {
    ent = await getEntitlements(scope.dataId);
  } catch (err) {
    console.error("[plans] entitlement lookup failed; allowing:", err);
    return;
  }
  if (ent.features[feature]) return;
  throw new PlanLimitError("feature", feature, null, 0, suggestFeaturePlan(ent.plan, feature), `${FEATURE_LABEL[feature]} is not included in your plan.`);
}

export async function assertWithinLimit(scope: ScopeLike, metric: Metric, increment = 1): Promise<void> {
  if (!plansEnforced()) return;
  let check;
  try {
    check = await checkLimit(scope.dataId, metric, increment);
  } catch (err) {
    console.error("[plans] limit lookup failed; allowing:", err);
    return;
  }
  if (check.allowed) return;
  throw new PlanLimitError("limit", metric, check.limit, check.used, check.upgradeTo, `Your plan allows ${check.limit} for ${METRIC_LABEL[metric].toLowerCase()}; you are using ${check.used}.`);
}
