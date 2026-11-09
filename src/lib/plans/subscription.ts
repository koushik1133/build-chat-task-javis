import { query, queryOne } from "@/lib/dsql";
import { emitEvent } from "@/lib/events/bus";
import { TRIAL_DAYS, TRIAL_PLAN, isBillingInterval, isPlanKey, type BillingInterval, type PlanKey } from "./catalog";
import type { SubStatus } from "./rules";

/** Subscription row access, lazy trial creation and cancel/resume. */

export interface SubscriptionRow {
  user_id: string;
  plan_key: string;
  status: string;
  billing_interval: string;
  currency: string;
  seats_purchased: number;
  trial_ends_at: Date | string | null;
  current_period_start: Date | string | null;
  current_period_end: Date | string | null;
  cancel_at_period_end: boolean;
  provider: string | null;
  provider_customer_ref: string | null;
  provider_subscription_ref: string | null;
  pending_plan_key: string | null;
  pending_interval: string | null;
  pending_seats: number | null;
  created_at: Date | string;
  updated_at: Date | string;
}

export interface SubscriptionDTO {
  plan_key: PlanKey;
  status: SubStatus;
  billing_interval: BillingInterval;
  currency: string;
  seats_purchased: number;
  trial_ends_at: string | null;
  current_period_start: string | null;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
  provider: string | null;
  pending: { plan_key: PlanKey | null; billing_interval: BillingInterval | null; seats: number | null } | null;
}

export class PlanError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 400) {
    super(message);
    this.name = "PlanError";
  }
}

export function iso(v: Date | string | null | undefined): string | null {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function toSubscriptionDTO(r: SubscriptionRow): SubscriptionDTO {
  const hasPending = Boolean(r.pending_plan_key || r.pending_interval || r.pending_seats);
  return {
    plan_key: isPlanKey(r.plan_key) ? r.plan_key : "free",
    status: r.status as SubStatus,
    billing_interval: isBillingInterval(r.billing_interval) ? r.billing_interval : "month",
    currency: r.currency,
    seats_purchased: Number(r.seats_purchased),
    trial_ends_at: iso(r.trial_ends_at),
    current_period_start: iso(r.current_period_start),
    current_period_end: iso(r.current_period_end),
    cancel_at_period_end: Boolean(r.cancel_at_period_end),
    provider: r.provider,
    pending: hasPending
      ? {
          plan_key: isPlanKey(r.pending_plan_key) ? r.pending_plan_key : null,
          billing_interval: isBillingInterval(r.pending_interval) ? r.pending_interval : null,
          seats: r.pending_seats === null ? null : Number(r.pending_seats),
        }
      : null,
  };
}

export async function findSubscription(dataId: string): Promise<SubscriptionRow | null> {
  return queryOne<SubscriptionRow>(`SELECT * FROM subscriptions WHERE user_id = $1`, [dataId]);
}

/**
 * The org's subscription. First touch lazily starts the Growth trial
 * (idempotent: the insert is `ON CONFLICT DO NOTHING`, only the winner emits).
 */
export async function getSubscription(dataId: string, currency = "USD"): Promise<SubscriptionRow> {
  const existing = await findSubscription(dataId);
  if (existing) return existing;
  const trialEnds = new Date(Date.now() + TRIAL_DAYS * 86_400_000);
  const created = await queryOne<SubscriptionRow>(
    `INSERT INTO subscriptions (user_id, plan_key, status, billing_interval, currency, seats_purchased, trial_ends_at, current_period_start, current_period_end)
     VALUES ($1, $2, 'trialing', 'month', $3, 1, $4, NOW(), $4)
     ON CONFLICT (user_id) DO NOTHING
     RETURNING *`,
    [dataId, TRIAL_PLAN, currency.toUpperCase(), trialEnds.toISOString()]
  );
  if (created) {
    void emitEvent(dataId, { type: "subscription.created", entity: "subscription", entityId: dataId, data: { plan: TRIAL_PLAN, status: "trialing", trial_ends_at: trialEnds.toISOString() } });
    return created;
  }
  const row = await findSubscription(dataId);
  if (!row) throw new Error("subscription missing after insert");
  return row;
}

export function isPaidSubscription(r: SubscriptionRow): boolean {
  return (r.status === "active" || r.status === "past_due") && r.plan_key !== "free" && Boolean(r.current_period_end);
}

/** Cancel at period end (access continues until then). */
export async function cancelAtPeriodEnd(dataId: string): Promise<SubscriptionRow> {
  const sub = await getSubscription(dataId);
  if (!isPaidSubscription(sub)) throw new PlanError("no_paid_subscription", "There is no paid subscription to cancel.", 409);
  const row = await queryOne<SubscriptionRow>(
    `UPDATE subscriptions SET cancel_at_period_end = TRUE, pending_plan_key = NULL, pending_interval = NULL, pending_seats = NULL, updated_at = NOW()
      WHERE user_id = $1 RETURNING *`,
    [dataId]
  );
  return row ?? sub;
}

export async function resumeSubscription(dataId: string): Promise<SubscriptionRow> {
  const sub = await getSubscription(dataId);
  if (!sub.cancel_at_period_end) throw new PlanError("not_cancelling", "This subscription is not scheduled to cancel.", 409);
  const row = await queryOne<SubscriptionRow>(
    `UPDATE subscriptions SET cancel_at_period_end = FALSE, updated_at = NOW() WHERE user_id = $1 RETURNING *`,
    [dataId]
  );
  return row ?? sub;
}

export async function clearPending(dataId: string): Promise<void> {
  await query(`UPDATE subscriptions SET pending_plan_key = NULL, pending_interval = NULL, pending_seats = NULL, updated_at = NOW() WHERE user_id = $1`, [dataId]);
}
