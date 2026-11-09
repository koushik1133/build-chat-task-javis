import { queryOne } from "@/lib/dsql";
import { requestMemo } from "@/lib/request-cache";
import {
  METRICS,
  METRIC_LIMIT,
  suggestFeaturePlan,
  suggestUpgrade,
  type FeatureKey,
  type Metric,
  type PlanKey,
} from "./catalog";
import { evaluateLimit, parseOverride, resolveEntitlements, type LimitCheck, type ResolvedEntitlements } from "./rules";
import { getSubscription } from "./subscription";
import { measure, measureAll } from "./usage";

/** True when plan limits are enforced (PLANS_ENFORCED=true). Default off. */
export function plansEnforced(env: Record<string, string | undefined> = process.env): boolean {
  return (env.PLANS_ENFORCED ?? "").trim().toLowerCase() === "true";
}

async function loadOverride(dataId: string) {
  const row = await queryOne<{ entitlements: string }>(`SELECT entitlements FROM plan_overrides WHERE user_id = $1`, [dataId]).catch(() => null);
  return parseOverride(row?.entitlements);
}

/**
 * Client workspaces (agency children) have a synthetic data id and no plan of their own: they are
 * covered by the parent workspace's subscription. Without this every child would start its own
 * trial and fall to Free (250 contacts, 2 seats) two weeks later.
 */
async function billingDataId(dataId: string): Promise<string> {
  const row = await queryOne<{ parent_owner: string | null }>(
    `SELECT p.owner_user_id AS parent_owner FROM organizations c JOIN organizations p ON p.id = c.parent_org_id WHERE c.owner_user_id = $1 LIMIT 1`,
    [dataId]
  ).catch(() => null);
  return row?.parent_owner || dataId;
}

async function loadEntitlements(dataId: string): Promise<ResolvedEntitlements> {
  const billing = await billingDataId(dataId);
  const [sub, override] = await Promise.all([getSubscription(billing), loadOverride(billing)]);
  return resolveEntitlements(sub, override);
}

/** Plan + override + trial state, memoised per request. */
export const getEntitlements: (dataId: string) => Promise<ResolvedEntitlements> = requestMemo(loadEntitlements);

export async function hasFeature(dataId: string, feature: FeatureKey): Promise<boolean> {
  return (await loadEntitlements(dataId)).features[feature];
}

export interface FullLimitCheck extends LimitCheck {
  metric: Metric;
  enforced: boolean;
  /** True when adding `increment` would exceed the limit (regardless of enforcement). */
  over: boolean;
}

/**
 * Would adding `increment` to `metric` stay within the plan? When enforcement
 * is off, `allowed` is always true but `over` still reports the truth.
 */
export async function checkLimit(dataId: string, metric: Metric, increment = 1): Promise<FullLimitCheck> {
  const ent = await loadEntitlements(dataId);
  const limit = ent.limits[METRIC_LIMIT[metric]];
  const used = await measure(dataId, metric);
  const fits = evaluateLimit(used, limit, increment);
  return {
    metric,
    enforced: plansEnforced(),
    allowed: plansEnforced() ? fits : true,
    over: !fits,
    used,
    limit,
    upgradeTo: fits ? null : suggestUpgrade(ent.plan, METRIC_LIMIT[metric], used + increment),
  };
}

export interface PlanSummary {
  entitlements: ResolvedEntitlements;
  usage: Array<{ metric: Metric; used: number; limit: number | null }>;
  enforced: boolean;
  upgrade_hints: Partial<Record<FeatureKey, PlanKey | null>>;
}

export async function buildPlanSummary(dataId: string): Promise<PlanSummary> {
  const [ent, used] = await Promise.all([loadEntitlements(dataId), measureAll(dataId)]);
  const hints: Partial<Record<FeatureKey, PlanKey | null>> = {};
  for (const [k, on] of Object.entries(ent.features) as Array<[FeatureKey, boolean]>) if (!on) hints[k] = suggestFeaturePlan(ent.plan, k);
  return {
    entitlements: ent,
    usage: METRICS.map((m) => ({ metric: m, used: used[m], limit: ent.limits[METRIC_LIMIT[m]] })),
    enforced: plansEnforced(),
    upgrade_hints: hints,
  };
}
