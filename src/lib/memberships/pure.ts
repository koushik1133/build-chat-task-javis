import { advanceNextRun, type ScheduleInterval } from "@/lib/money/cadence";

/** Membership maths and state rules (pure, client-safe: no DB imports). */

export const SUB_STATUSES = ["incomplete", "trialing", "active", "past_due", "paused", "cancelled", "expired"] as const;
export type SubStatus = (typeof SUB_STATUSES)[number];
export const PLAN_INTERVALS = ["week", "month", "quarter", "year"] as const;
export type PlanInterval = (typeof PLAN_INTERVALS)[number];
export const INTERVAL_LABEL: Record<PlanInterval, string> = { week: "week", month: "month", quarter: "quarter", year: "year" };
export const CHARGE_STATUSES = ["pending", "paid", "failed", "void"] as const;
export type ChargeStatus = (typeof CHARGE_STATUSES)[number];

/** Statuses that count as a seat toward `max_members`. */
export const SEAT_STATUSES: readonly SubStatus[] = ["incomplete", "trialing", "active", "past_due", "paused"];
/** Statuses that grant access to the member benefits (past_due keeps a grace period until the final retry fails). */
export const ACCESS_STATUSES: readonly SubStatus[] = ["trialing", "active", "past_due"];
/** Days after the first failed attempt on which payment is retried; the next failure after the last entry expires the membership. */
export const RETRY_DAYS: readonly number[] = [1, 3, 7];
export const TRIAL_REMINDER_DAYS = 3;
export const INCOMPLETE_EXPIRY_DAYS = 3;
export const DAY_MS = 86_400_000;

const SCHEDULE: Record<PlanInterval, ScheduleInterval> = { week: "weekly", month: "monthly", quarter: "quarterly", year: "yearly" };

export function isPlanInterval(v: unknown): v is PlanInterval {
  return typeof v === "string" && (PLAN_INTERVALS as readonly string[]).includes(v);
}

/** End of the period starting at `from`. `anchorDay` keeps month-end subscribers on their day (Jan 31 → Feb 28 → Mar 31). */
export function advancePeriod(from: Date, interval: PlanInterval, count: number, anchorDay: number | null = null): Date {
  return advanceNextRun(from, SCHEDULE[interval], count, anchorDay);
}

export function periodLabel(interval: PlanInterval, count: number): string {
  const n = Math.max(1, Math.floor(count));
  return n === 1 ? INTERVAL_LABEL[interval] : `${n} ${INTERVAL_LABEL[interval]}s`;
}

export interface ProrationInput {
  oldUnitMinor: number;
  oldQty: number;
  newUnitMinor: number;
  newQty: number;
  periodStart: Date;
  periodEnd: Date;
  now: Date;
}
export interface ProrationResult {
  /** Fraction of the current period still to run, 0..1. */
  remaining: number;
  /** Unused value of the old plan (credit to the customer). */
  creditMinor: number;
  /** Cost of the new plan for the remainder of the period. */
  chargeMinor: number;
  /** charge - credit: positive = customer owes, negative = customer is owed. */
  netMinor: number;
}

/** Pure proration for a mid-period plan/quantity change. Outside the period it is zero. */
export function prorate(i: ProrationInput): ProrationResult {
  const span = i.periodEnd.getTime() - i.periodStart.getTime();
  const left = i.periodEnd.getTime() - i.now.getTime();
  const remaining = span <= 0 ? 0 : Math.min(Math.max(left / span, 0), 1);
  const creditMinor = Math.round(i.oldUnitMinor * i.oldQty * remaining);
  const chargeMinor = Math.round(i.newUnitMinor * i.newQty * remaining);
  return { remaining, creditMinor, chargeMinor, netMinor: chargeMinor - creditMinor };
}

export interface PeriodLinesInput {
  planName: string;
  label: string;
  unitMinor: number;
  quantity: number;
  taxRateId: string | null;
  productId: string | null;
  setupFeeMinor: number;
  /** Carried plan-change balance: positive = owed, negative = credit to use up. */
  adjustmentMinor: number;
  includePeriod: boolean;
}
export interface InvoiceLineLike {
  description: string;
  qty: number;
  unit_minor: number;
  tax_rate_bp: number;
  tax_rate_id?: string | null;
  product_id?: string;
}

/**
 * Invoice lines for a charge. Invoices cannot carry negative lines, so a credit is netted into the
 * period line (never below zero); any unused credit stays on the subscription for the next period.
 */
export function buildPeriodLines(i: PeriodLinesInput): { lines: InvoiceLineLike[]; adjustmentLeftMinor: number } {
  const lines: InvoiceLineLike[] = [];
  let left = i.adjustmentMinor;
  const tax = i.taxRateId ?? undefined;
  if (i.setupFeeMinor > 0) lines.push({ description: `${i.planName} setup fee`, qty: 1, unit_minor: i.setupFeeMinor, tax_rate_bp: 0, tax_rate_id: tax });
  if (i.includePeriod) {
    const gross = Math.round(i.unitMinor * i.quantity);
    if (left < 0 && gross > 0) {
      const used = Math.min(-left, gross);
      left += used;
      lines.push({ description: `${i.planName} (${i.label}) — includes plan-change credit`, qty: 1, unit_minor: gross - used, tax_rate_bp: 0, tax_rate_id: tax });
    } else {
      lines.push({ description: `${i.planName} (${i.label})`, qty: i.quantity, unit_minor: i.unitMinor, tax_rate_bp: 0, tax_rate_id: tax, ...(i.productId ? { product_id: i.productId } : {}) });
    }
    if (left > 0) {
      lines.push({ description: "Plan change adjustment", qty: 1, unit_minor: left, tax_rate_bp: 0, tax_rate_id: tax });
      left = 0;
    }
  }
  return { lines, adjustmentLeftMinor: left };
}

export type DunningAction = { action: "retry"; at: Date } | { action: "expire" };

/**
 * After the `failedAttempts`-th unsuccessful attempt (1-based) of a period whose first attempt was at
 * `anchor`: retry on the next scheduled day, or expire once the schedule is exhausted.
 */
export function dunningStep(failedAttempts: number, anchor: Date, schedule: readonly number[] = RETRY_DAYS): DunningAction {
  if (failedAttempts > schedule.length) return { action: "expire" };
  const day = schedule[Math.max(failedAttempts, 1) - 1];
  return { action: "retry", at: new Date(anchor.getTime() + day * DAY_MS) };
}

/** Status after a failed attempt: a saved-card decline is past_due at once; a manual-pay link gets one grace retry first. */
export function statusAfterFailure(prev: SubStatus, failedAttempts: number, hasSavedMethod: boolean): SubStatus {
  if (prev === "cancelled" || prev === "expired" || prev === "paused") return prev;
  if (hasSavedMethod || failedAttempts >= 2) return "past_due";
  return prev;
}

export function canTransition(from: SubStatus, to: SubStatus): boolean {
  const T: Record<SubStatus, SubStatus[]> = {
    incomplete: ["trialing", "active", "cancelled", "expired"],
    trialing: ["active", "past_due", "paused", "cancelled", "expired"],
    active: ["past_due", "paused", "cancelled", "expired"],
    past_due: ["active", "paused", "cancelled", "expired"],
    paused: ["active", "cancelled", "expired"],
    cancelled: [],
    expired: [],
  };
  return from === to || T[from].includes(to);
}

export interface PlanBenefit {
  label: string;
}
export function parseBenefits(raw: string | null | undefined): PlanBenefit[] {
  if (!raw) return [];
  try {
    const v: unknown = JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    const out: PlanBenefit[] = [];
    for (const b of v) {
      const label = b && typeof b === "object" ? (b as Record<string, unknown>).label : typeof b === "string" ? b : null;
      if (typeof label === "string" && label.trim()) out.push({ label: label.trim().slice(0, 200) });
    }
    return out.slice(0, 30);
  } catch {
    return [];
  }
}

export function slugify(s: string): string {
  return s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "plan";
}

export interface MetricRow {
  status: SubStatus;
  amount_minor: number;
  quantity: number;
  interval: PlanInterval;
  interval_count: number;
  currency: string;
  start_at: string | Date;
  cancelled_at: string | Date | null;
  trial_ends_at: string | Date | null;
  /** Subscriber has paid at least one charge since the trial ended (or without a trial). */
  converted: boolean;
}
export interface MembershipMetrics {
  /** Normalised monthly recurring revenue per currency (minor units). */
  mrr_minor: Record<string, number>;
  primary_currency: string | null;
  active_members: number;
  trialing: number;
  past_due: number;
  churned_30d: number;
  /** Cancellations + expiries in the last 30 days over members at the start of that window, in percent (1 dp). */
  churn_pct: number;
  /** Of trials that ended, the share that went on to pay. null when no trial has ended. */
  trial_conversion_pct: number | null;
  /** New members per calendar month (UTC), oldest first, last 6 months. */
  new_by_month: Array<{ month: string; count: number }>;
}

/** Monthly-equivalent of one subscription's recurring price. */
export function monthlyEquivalent(amountMinor: number, quantity: number, interval: PlanInterval, count: number): number {
  const n = Math.max(1, count);
  const total = amountMinor * Math.max(1, quantity);
  if (interval === "week") return Math.round((total * 52) / 12 / n);
  if (interval === "month") return Math.round(total / n);
  if (interval === "quarter") return Math.round(total / (3 * n));
  return Math.round(total / (12 * n));
}

export function membershipMetrics(rows: readonly MetricRow[], now: Date = new Date()): MembershipMetrics {
  const mrr: Record<string, number> = {};
  let active = 0;
  let trialing = 0;
  let pastDue = 0;
  let churned = 0;
  let atStart = 0;
  let trialsEnded = 0;
  let trialsConverted = 0;
  const since = now.getTime() - 30 * DAY_MS;
  for (const r of rows) {
    const start = new Date(r.start_at).getTime();
    const ended = r.status === "cancelled" || r.status === "expired";
    const endedAt = r.cancelled_at ? new Date(r.cancelled_at).getTime() : null;
    if (r.status === "active" || r.status === "past_due") {
      active++;
      mrr[r.currency] = (mrr[r.currency] ?? 0) + monthlyEquivalent(r.amount_minor, r.quantity, r.interval, r.interval_count);
    }
    if (r.status === "trialing") trialing++;
    if (r.status === "past_due") pastDue++;
    const payingAtStart = start <= since && r.status !== "incomplete" && (!ended || endedAt === null || endedAt >= since);
    if (payingAtStart) atStart++;
    if (ended && endedAt !== null && endedAt >= since && start <= since) churned++;
    if (r.trial_ends_at && new Date(r.trial_ends_at).getTime() <= now.getTime()) {
      trialsEnded++;
      if (r.converted) trialsConverted++;
    }
  }
  const months: Array<{ month: string; count: number }> = [];
  for (let k = 5; k >= 0; k--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - k, 1));
    months.push({ month: `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`, count: 0 });
  }
  for (const r of rows) {
    const d = new Date(r.start_at);
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    const m = months.find((x) => x.month === key);
    if (m) m.count++;
  }
  const primary = Object.entries(mrr).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  return {
    mrr_minor: mrr,
    primary_currency: primary,
    active_members: active,
    trialing,
    past_due: pastDue,
    churned_30d: churned,
    churn_pct: atStart > 0 ? Math.round((churned / atStart) * 1000) / 10 : 0,
    trial_conversion_pct: trialsEnded > 0 ? Math.round((trialsConverted / trialsEnded) * 1000) / 10 : null,
    new_by_month: months,
  };
}
