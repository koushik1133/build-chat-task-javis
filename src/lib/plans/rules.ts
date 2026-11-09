import {
  FEATURE_KEYS,
  LIMIT_KEYS,
  PLANS,
  isPlanKey,
  type BillingInterval,
  type FeatureKey,
  type LimitKey,
  type PlanKey,
} from "./catalog";

/** Pure plan rules (no I/O) so they are trivially testable and client-safe. */

export type SubStatus = "trialing" | "active" | "past_due" | "cancelled" | "paused";

export interface SubLike {
  plan_key: string;
  status: string;
  trial_ends_at: string | Date | null;
  seats_purchased: number;
}

export interface EntitlementOverride {
  plan_key?: PlanKey;
  limits?: Partial<Record<LimitKey, number | null>>;
  features?: Partial<Record<FeatureKey, boolean>>;
}

export interface ResolvedEntitlements {
  /** Plan whose limits apply right now (after trial expiry / cancellation). */
  plan: PlanKey;
  /** Plan the subscription row names (what the customer picked). */
  subscribedPlan: PlanKey;
  status: SubStatus;
  limits: Record<LimitKey, number | null>;
  features: Record<FeatureKey, boolean>;
  trial: { active: boolean; endsAt: string | null; daysLeft: number };
  overridden: boolean;
}

const DAY = 86_400_000;

function ms(v: string | Date | null | undefined): number | null {
  if (!v) return null;
  const t = v instanceof Date ? v.getTime() : new Date(v).getTime();
  return Number.isFinite(t) ? t : null;
}

export function parseOverride(raw: string | null | undefined): EntitlementOverride | null {
  if (!raw) return null;
  try {
    const j = JSON.parse(raw) as unknown;
    if (!j || typeof j !== "object") return null;
    const o = j as Record<string, unknown>;
    const out: EntitlementOverride = {};
    if (isPlanKey(o.plan_key)) out.plan_key = o.plan_key;
    if (o.limits && typeof o.limits === "object") {
      out.limits = {};
      for (const k of LIMIT_KEYS) {
        const v = (o.limits as Record<string, unknown>)[k];
        if (v === null || (typeof v === "number" && Number.isFinite(v) && v >= 0)) out.limits[k] = v;
      }
    }
    if (o.features && typeof o.features === "object") {
      out.features = {};
      for (const k of FEATURE_KEYS) {
        const v = (o.features as Record<string, unknown>)[k];
        if (typeof v === "boolean") out.features[k] = v;
      }
    }
    return out;
  } catch {
    return null;
  }
}

export function resolveEntitlements(sub: SubLike | null, override: EntitlementOverride | null, now = new Date()): ResolvedEntitlements {
  const status = (sub?.status ?? "cancelled") as SubStatus;
  const subscribedPlan: PlanKey = sub && isPlanKey(sub.plan_key) ? sub.plan_key : "free";
  const trialEnd = ms(sub?.trial_ends_at ?? null);
  const trialActive = status === "trialing" && trialEnd !== null && trialEnd > now.getTime();

  let plan: PlanKey;
  if (!sub) plan = "free";
  else if (status === "trialing") plan = trialActive ? subscribedPlan : "free";
  else if (status === "active" || status === "past_due") plan = subscribedPlan;
  else plan = "free";

  if (override?.plan_key) plan = override.plan_key;
  const def = PLANS[plan];
  const limits = { ...def.entitlements.limits };
  const features = { ...def.entitlements.features };

  // Purchased seats raise the seat cap while the plan is the one that was bought.
  if (sub && plan === subscribedPlan && limits.seats !== null && (status === "active" || status === "past_due")) {
    limits.seats = Math.max(limits.seats, Math.trunc(sub.seats_purchased) || 0);
  }
  let overridden = Boolean(override?.plan_key);
  if (override?.limits) {
    for (const k of LIMIT_KEYS) if (k in override.limits) { limits[k] = override.limits[k] ?? null; overridden = true; }
  }
  if (override?.features) {
    for (const k of FEATURE_KEYS) if (k in override.features) { features[k] = Boolean(override.features[k]); overridden = true; }
  }
  const daysLeft = trialActive && trialEnd !== null ? Math.max(0, Math.ceil((trialEnd - now.getTime()) / DAY)) : 0;
  return {
    plan,
    subscribedPlan,
    status,
    limits,
    features,
    trial: { active: trialActive, endsAt: trialEnd ? new Date(trialEnd).toISOString() : null, daysLeft },
    overridden,
  };
}

/* ── limits ────────────────────────────────────────────────────────────── */

export interface LimitCheck {
  allowed: boolean;
  used: number;
  limit: number | null;
  upgradeTo: PlanKey | null;
}

/** `limit === null` is unlimited. Adding `increment` must not exceed the limit. */
export function evaluateLimit(used: number, limit: number | null, increment = 1): boolean {
  if (limit === null) return true;
  return used + Math.max(0, increment) <= limit;
}

/** Percent used, capped for display; 0 when unlimited. */
export function usagePercent(used: number, limit: number | null): number {
  if (limit === null || limit <= 0) return limit === 0 && used > 0 ? 100 : 0;
  return Math.min(100, Math.round((used / limit) * 100));
}

/* ── periods ───────────────────────────────────────────────────────────── */

/** Add whole months in UTC, clamping to the last day (Jan 31 + 1 month = Feb 28/29). */
export function addMonthsClamped(date: Date, months: number): Date {
  const y = date.getUTCFullYear();
  const m = date.getUTCMonth() + months;
  const first = new Date(Date.UTC(y, m, 1, date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds(), date.getUTCMilliseconds()));
  const lastDay = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  first.setUTCDate(Math.min(date.getUTCDate(), lastDay));
  return first;
}

export function advancePeriod(periodEnd: Date, interval: BillingInterval): { start: Date; end: Date } {
  return { start: periodEnd, end: addMonthsClamped(periodEnd, interval === "year" ? 12 : 1) };
}

/** First day (UTC) of the month containing `d`, as YYYY-MM-DD. */
export function monthStart(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-01`;
}

/* ── proration ─────────────────────────────────────────────────────────── */

/**
 * Charge for an immediate upgrade: the price difference for the unused part of
 * the current period. Never negative (downgrades take effect next period).
 */
export function prorateUpgrade(input: { oldAmountMinor: number; newAmountMinor: number; periodStart: Date; periodEnd: Date; now: Date }): number {
  const total = input.periodEnd.getTime() - input.periodStart.getTime();
  if (total <= 0) return Math.max(0, input.newAmountMinor - input.oldAmountMinor);
  const remaining = Math.min(total, Math.max(0, input.periodEnd.getTime() - input.now.getTime()));
  const diff = input.newAmountMinor - input.oldAmountMinor;
  if (diff <= 0) return 0;
  return Math.round((diff * remaining) / total);
}

/* ── renewal state machine ─────────────────────────────────────────────── */

export const GRACE_DAYS = 3;
export const DOWNGRADE_AFTER_PAST_DUE_DAYS = 7;

export type RenewalAction = "none" | "renew" | "past_due" | "downgrade" | "cancel" | "expire_trial";

export interface RenewalInput {
  status: string;
  provider: string | null;
  cancel_at_period_end: boolean;
  current_period_end: string | Date | null;
  trial_ends_at: string | Date | null;
}

/**
 * What `renewDue` should do with a subscription right now.
 *  - simulated provider auto-renews as paid; real providers renew through webhooks
 *  - unpaid after GRACE_DAYS -> past_due; GRACE + 7 days -> downgraded to Free
 *  - cancel_at_period_end ends at the period boundary
 */
export function nextRenewalAction(sub: RenewalInput, now: Date): RenewalAction {
  const t = now.getTime();
  if (sub.status === "trialing") {
    const end = ms(sub.trial_ends_at);
    return end !== null && end <= t ? "expire_trial" : "none";
  }
  if (sub.status !== "active" && sub.status !== "past_due") return "none";
  const end = ms(sub.current_period_end);
  if (end === null || end > t) return "none";
  if (sub.cancel_at_period_end) return "cancel";
  if (sub.provider === "simulated") return "renew";
  const lateDays = (t - end) / DAY;
  if (lateDays >= GRACE_DAYS + DOWNGRADE_AFTER_PAST_DUE_DAYS) return "downgrade";
  if (lateDays >= GRACE_DAYS) return sub.status === "past_due" ? "none" : "past_due";
  return "none";
}
