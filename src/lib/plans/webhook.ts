import { randomUUID } from "crypto";
import { query, queryOne } from "@/lib/dsql";
import { emitEvent } from "@/lib/events/bus";
import { postLedger } from "@/lib/credits/ledger";
import type { PaymentEvent } from "@/lib/payments/types";
import { PLANS, isBillingInterval, isPlanKey, periodAmountMinor, type BillingInterval } from "./catalog";
import { PLAN_REF_PREFIX, type PlanInvoiceRow } from "./checkout";
import { addMonthsClamped, monthStart, resolveEntitlements } from "./rules";
import { findSubscription, type SubscriptionRow } from "./subscription";
import { recordUsage } from "./usage";

/**
 * Apply a verified provider payment event to a plan invoice.
 * Returns null when the event is not about a plan invoice so the caller can
 * fall through. The invoice flips `open -> paid` with a conditional UPDATE, so
 * replays and parallel deliveries activate the subscription once; the monthly
 * credit grant is idempotent on its own.
 */
export interface PlanPaymentResult {
  invoiceId: string;
  status: "paid" | "failed" | "ignored";
  activated: boolean;
  reason?: string;
}

async function findInvoice(providerId: string, evt: PaymentEvent): Promise<PlanInvoiceRow | null> {
  if (evt.invoiceId && evt.invoiceId.startsWith(PLAN_REF_PREFIX)) {
    const row = await queryOne<PlanInvoiceRow>(`SELECT * FROM plan_invoices WHERE id = $1`, [evt.invoiceId.slice(PLAN_REF_PREFIX.length)]);
    if (row) return row;
  }
  if (evt.providerRef) {
    return queryOne<PlanInvoiceRow>(`SELECT * FROM plan_invoices WHERE provider = $1 AND provider_ref = $2 ORDER BY created_at DESC LIMIT 1`, [providerId, evt.providerRef]);
  }
  return null;
}

/** Grant the plan's included AI credits for the month of `now`, at most once. */
export async function grantCreditsFor(sub: SubscriptionRow, now = new Date()): Promise<{ granted: number; duplicate: boolean }> {
  const ent = resolveEntitlements(sub, null, now);
  const credits = ent.limits.ai_credits_included_per_month;
  if (!credits || credits <= 0) return { granted: 0, duplicate: false };
  if (ent.status !== "active" && ent.status !== "past_due" && !ent.trial.active) return { granted: 0, duplicate: false };
  const ym = monthStart(now).slice(0, 7);
  const posted = await postLedger(sub.user_id, { kind: "grant", credits, refKind: "plan", refId: `plan/${ym}`, note: `${PLANS[ent.plan].name} plan monthly credits` });
  if (!posted.duplicate) await recordUsage(sub.user_id, "credits_granted", 1, now);
  return { granted: posted.duplicate ? 0 : credits, duplicate: posted.duplicate };
}

/** Apply a paid invoice to the subscription. Called once, by whoever flipped the invoice to paid. */
export async function applyPaidInvoice(inv: PlanInvoiceRow, providerId: string, now = new Date()): Promise<SubscriptionRow | null> {
  const before = await findSubscription(inv.user_id);
  if (!before) return null;
  const interval: BillingInterval = isBillingInterval(inv.billing_interval) ? inv.billing_interval : "month";
  const planKey = isPlanKey(inv.plan_key) ? inv.plan_key : before.plan_key;
  let after: SubscriptionRow | null = null;

  if (inv.kind === "subscribe") {
    const end = addMonthsClamped(now, interval === "year" ? 12 : 1);
    after = await queryOne<SubscriptionRow>(
      `UPDATE subscriptions SET plan_key = $2, status = 'active', billing_interval = $3, currency = $4, seats_purchased = $5,
              current_period_start = $6, current_period_end = $7, cancel_at_period_end = FALSE,
              pending_plan_key = NULL, pending_interval = NULL, pending_seats = NULL,
              provider = $8, provider_subscription_ref = COALESCE(provider_subscription_ref, $9), updated_at = NOW()
        WHERE user_id = $1 RETURNING *`,
      [inv.user_id, planKey, interval, inv.currency, inv.seats, now.toISOString(), end.toISOString(), providerId, inv.provider_ref]
    );
  } else if (inv.kind === "upgrade") {
    after = await queryOne<SubscriptionRow>(
      `UPDATE subscriptions SET plan_key = $2, seats_purchased = $3, pending_plan_key = NULL, pending_interval = NULL, pending_seats = NULL, updated_at = NOW()
        WHERE user_id = $1 RETURNING *`,
      [inv.user_id, planKey, inv.seats]
    );
  } else if (inv.kind === "seats") {
    after = await queryOne<SubscriptionRow>(`UPDATE subscriptions SET seats_purchased = $2, pending_seats = NULL, updated_at = NOW() WHERE user_id = $1 RETURNING *`, [inv.user_id, inv.seats]);
  } else if (inv.kind === "renewal") {
    after = await advanceAfterRenewal(before, providerId, now);
  }
  if (!after) return null;

  if (before.plan_key !== after.plan_key || before.status !== after.status && before.status === "trialing") {
    void emitEvent(inv.user_id, { type: "subscription.plan_changed", entity: "subscription", entityId: inv.user_id, data: { from: before.plan_key, to: after.plan_key, kind: inv.kind } });
  }
  if (inv.kind === "renewal") {
    void emitEvent(inv.user_id, { type: "subscription.renewed", entity: "subscription", entityId: inv.user_id, data: { plan: after.plan_key, period_end: after.current_period_end } });
  }
  await grantCreditsFor(after, now).catch((err) => console.error("[plans] credit grant failed:", err));
  return after;
}

/** Move to the next period, applying any scheduled plan/interval/seat change. */
export async function advanceAfterRenewal(sub: SubscriptionRow, providerId: string | null, now = new Date()): Promise<SubscriptionRow | null> {
  const plan = sub.pending_plan_key && isPlanKey(sub.pending_plan_key) ? sub.pending_plan_key : sub.plan_key;
  const interval = sub.pending_interval && isBillingInterval(sub.pending_interval) ? sub.pending_interval : sub.billing_interval;
  const included = PLANS[plan as keyof typeof PLANS]?.entitlements.limits.seats ?? 1;
  const seats = Math.max(included, sub.pending_seats ?? Number(sub.seats_purchased));
  const start = sub.current_period_end ? new Date(sub.current_period_end) : now;
  const end = addMonthsClamped(start, interval === "year" ? 12 : 1);
  return queryOne<SubscriptionRow>(
    `UPDATE subscriptions SET plan_key = $2, billing_interval = $3, seats_purchased = $4, status = 'active',
            current_period_start = $5, current_period_end = $6, pending_plan_key = NULL, pending_interval = NULL, pending_seats = NULL,
            provider = COALESCE($7, provider), updated_at = NOW()
      WHERE user_id = $1 AND ($8::timestamptz IS NULL AND current_period_end IS NULL OR ABS(EXTRACT(EPOCH FROM (current_period_end - $8::timestamptz))) < 0.01) RETURNING *`,
    [sub.user_id, plan, interval, seats, start.toISOString(), end.toISOString(), providerId, sub.current_period_end ? new Date(sub.current_period_end).toISOString() : null]
  );
}

export function renewalAmount(sub: SubscriptionRow): { amountMinor: number; planKey: string; interval: BillingInterval; seats: number } {
  const plan = sub.pending_plan_key && isPlanKey(sub.pending_plan_key) ? sub.pending_plan_key : sub.plan_key;
  const interval: BillingInterval = (sub.pending_interval && isBillingInterval(sub.pending_interval) ? sub.pending_interval : sub.billing_interval) === "year" ? "year" : "month";
  const def = PLANS[isPlanKey(plan) ? plan : "free"];
  const seats = Math.max(def.entitlements.limits.seats ?? 1, sub.pending_seats ?? Number(sub.seats_purchased));
  return { amountMinor: periodAmountMinor(def, interval, sub.currency, seats).amountMinor, planKey: def.key, interval, seats };
}

export async function handlePlanPaymentEvent(providerId: string, evt: PaymentEvent): Promise<PlanPaymentResult | null> {
  const inv = await findInvoice(providerId, evt).catch(() => null);
  if (!inv) {
    // A real provider's recurring charge for a subscription we already track.
    if (evt.type === "payment.succeeded" && evt.providerRef) return handleProviderRenewal(providerId, evt);
    return null;
  }

  if (evt.type === "payment.failed") {
    await query(`UPDATE plan_invoices SET status = 'failed' WHERE id = $1 AND status = 'open'`, [inv.id]);
    return { invoiceId: inv.id, status: "failed", activated: false };
  }
  const expected = Number(inv.amount_minor);
  if (evt.amountMinor < expected) return { invoiceId: inv.id, status: "ignored", activated: false, reason: `amount ${evt.amountMinor} < ${expected}` };
  if (evt.currency && evt.currency.toUpperCase() !== inv.currency.toUpperCase()) return { invoiceId: inv.id, status: "ignored", activated: false, reason: `currency ${evt.currency} ≠ ${inv.currency}` };

  const flipped = await queryOne<{ id: string }>(
    `UPDATE plan_invoices SET status = 'paid', paid_at = NOW(), provider_ref = COALESCE(provider_ref, $2) WHERE id = $1 AND status = 'open' RETURNING id`,
    [inv.id, evt.providerRef || null]
  );
  if (!flipped && inv.status !== "paid") return { invoiceId: inv.id, status: "ignored", activated: false, reason: `invoice is ${inv.status}` };
  if (flipped) {
    await applyPaidInvoice(inv, providerId);
    return { invoiceId: inv.id, status: "paid", activated: true };
  }
  // Replay: re-run only the idempotent credit grant so a crash after the flip self-heals.
  const sub = await findSubscription(inv.user_id);
  if (sub) await grantCreditsFor(sub).catch(() => undefined);
  return { invoiceId: inv.id, status: "paid", activated: false };
}

async function handleProviderRenewal(providerId: string, evt: PaymentEvent): Promise<PlanPaymentResult | null> {
  const sub = await queryOne<SubscriptionRow>(`SELECT * FROM subscriptions WHERE provider = $1 AND provider_subscription_ref = $2`, [providerId, evt.providerRef]);
  if (!sub) return null;
  const id = randomUUID();
  const r = renewalAmount(sub);
  await query(
    `INSERT INTO plan_invoices (id, user_id, subscription_id, kind, plan_key, billing_interval, seats, period_start, period_end, amount_minor, currency, status, provider, provider_ref, paid_at)
     VALUES ($1,$2,$3,'renewal',$4,$5,$6,$7,$8,$9,$10,'paid',$11,$12,NOW())`,
    [id, sub.user_id, sub.user_id, r.planKey, r.interval, r.seats, sub.current_period_end ? new Date(sub.current_period_end).toISOString() : null, addMonthsClamped(sub.current_period_end ? new Date(sub.current_period_end) : new Date(), r.interval === "year" ? 12 : 1).toISOString(), evt.amountMinor, sub.currency, providerId, evt.providerRef]
  );
  const inv = await queryOne<PlanInvoiceRow>(`SELECT * FROM plan_invoices WHERE id = $1`, [id]);
  if (inv) await applyPaidInvoice(inv, providerId);
  return { invoiceId: id, status: "paid", activated: true };
}

