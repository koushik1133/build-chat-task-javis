import { randomBytes, randomUUID } from "crypto";
import { query, queryOne } from "@/lib/dsql";
import { getProvider } from "@/lib/payments";
import { appOrigin, hashToken } from "@/lib/share-tokens";
import { getOrgSettings } from "@/lib/org-settings";
import {
  PLANS,
  getPlan,
  isBillingInterval,
  isPlanKey,
  periodAmountMinor,
  type BillingInterval,
  type PlanKey,
} from "./catalog";
import { addMonthsClamped, prorateUpgrade } from "./rules";
import { PlanError, cancelAtPeriodEnd, getSubscription, isPaidSubscription, iso, type SubscriptionRow } from "./subscription";
import { measure } from "./usage";

export const PLAN_REF_PREFIX = "plan:";
export const PLAN_LINK_TTL_MS = 7 * 86_400_000;

export type PlanInvoiceKind = "subscribe" | "upgrade" | "seats" | "renewal";

export interface PlanInvoiceRow {
  id: string;
  user_id: string;
  subscription_id: string;
  kind: PlanInvoiceKind;
  plan_key: string;
  billing_interval: string;
  seats: number;
  period_start: Date | string | null;
  period_end: Date | string | null;
  amount_minor: string | number;
  currency: string;
  status: "open" | "paid" | "void" | "failed";
  provider: string | null;
  provider_ref: string | null;
  token_hash: string | null;
  paid_at: Date | string | null;
  pdf_hash: string | null;
  created_at: Date | string;
}

export interface PlanInvoiceDTO {
  id: string;
  kind: PlanInvoiceKind;
  plan_key: string;
  plan_name: string;
  billing_interval: string;
  seats: number;
  amount_minor: number;
  currency: string;
  status: string;
  period_start: string | null;
  period_end: string | null;
  paid_at: string | null;
  created_at: string;
}

export function toPlanInvoiceDTO(r: PlanInvoiceRow): PlanInvoiceDTO {
  return {
    id: r.id,
    kind: r.kind,
    plan_key: r.plan_key,
    plan_name: getPlan(r.plan_key)?.name ?? r.plan_key,
    billing_interval: r.billing_interval,
    seats: Number(r.seats),
    amount_minor: Number(r.amount_minor),
    currency: r.currency,
    status: r.status,
    period_start: iso(r.period_start),
    period_end: iso(r.period_end),
    paid_at: iso(r.paid_at),
    created_at: iso(r.created_at) ?? "",
  };
}

export const planCheckoutPath = (token: string) => `/p/plan/${token}`;

export function isPlanInvoiceExpired(p: Pick<PlanInvoiceRow, "status" | "created_at">, now = Date.now()): boolean {
  if (p.status !== "open") return false;
  const t = new Date(p.created_at).getTime();
  return Number.isFinite(t) && now - t > PLAN_LINK_TTL_MS;
}

export async function getPlanInvoiceByToken(token: string): Promise<PlanInvoiceRow | null> {
  if (!token || token.length > 128 || !/^[A-Za-z0-9_-]+$/.test(token)) return null;
  return queryOne<PlanInvoiceRow>(`SELECT * FROM plan_invoices WHERE token_hash = $1`, [hashToken(token)]);
}

export async function listPlanInvoices(dataId: string, limit = 24): Promise<PlanInvoiceDTO[]> {
  const rows = await query<PlanInvoiceRow>(`SELECT * FROM plan_invoices WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`, [dataId, Math.min(Math.max(limit, 1), 100)]);
  return rows.map(toPlanInvoiceDTO);
}

export interface PlanChangeInput {
  planKey: string;
  interval: string;
  seats?: number;
}

export type CheckoutOutcome =
  | { scheduled: false; url: string; invoiceId: string; token: string; provider: string; amountMinor: number; currency: string; kind: PlanInvoiceKind }
  | { scheduled: true; effectiveAt: string | null; note: string };

/** Amount of one full period for the subscription as currently held. */
export function currentPeriodAmount(sub: SubscriptionRow): number {
  const plan = getPlan(sub.plan_key);
  if (!plan) return 0;
  return periodAmountMinor(plan, sub.billing_interval === "year" ? "year" : "month", sub.currency, Number(sub.seats_purchased)).amountMinor;
}

async function createInvoiceAndCheckout(
  dataId: string,
  sub: SubscriptionRow,
  inv: { kind: PlanInvoiceKind; planKey: PlanKey; interval: BillingInterval; seats: number; amountMinor: number; currency: string; description: string; periodStart: Date | null; periodEnd: Date | null }
): Promise<Extract<CheckoutOutcome, { scheduled: false }>> {
  const provider = getProvider();
  const id = randomUUID();
  const token = randomBytes(24).toString("base64url");
  const origin = appOrigin();
  const returnUrl = `${origin}${planCheckoutPath(token)}`;
  const checkout = await provider.createCheckout({
    invoiceId: `${PLAN_REF_PREFIX}${id}`,
    amountMinor: inv.amountMinor,
    currency: inv.currency,
    description: inv.description,
    successUrl: `${returnUrl}?outcome=success`,
    cancelUrl: `${returnUrl}?outcome=cancel`,
    token,
  });
  await query(
    `INSERT INTO plan_invoices (id, user_id, subscription_id, kind, plan_key, billing_interval, seats, period_start, period_end, amount_minor, currency, status, provider, provider_ref, token_hash)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'open',$12,$13,$14)`,
    [id, dataId, sub.user_id, inv.kind, inv.planKey, inv.interval, inv.seats, inv.periodStart?.toISOString() ?? null, inv.periodEnd?.toISOString() ?? null, inv.amountMinor, inv.currency, provider.id, checkout.providerRef, hashToken(token)]
  );
  const url = provider.id === "simulated" ? returnUrl : checkout.url.startsWith("/") ? `${origin}${checkout.url}` : checkout.url;
  return { scheduled: false, url, invoiceId: id, token, provider: provider.id, amountMinor: inv.amountMinor, currency: inv.currency, kind: inv.kind };
}

async function schedule(dataId: string, patch: { plan?: PlanKey | null; interval?: BillingInterval | null; seats?: number | null }): Promise<void> {
  await query(
    `UPDATE subscriptions SET pending_plan_key = $2, pending_interval = $3, pending_seats = $4, cancel_at_period_end = FALSE, updated_at = NOW() WHERE user_id = $1`,
    [dataId, patch.plan ?? null, patch.interval ?? null, patch.seats ?? null]
  );
}

/**
 * Start a plan purchase or change.
 *  - not paying yet (trial / free / cancelled): full-price checkout, period starts on payment
 *  - paying + higher plan, same interval: immediate upgrade, prorated charge for the rest of the period
 *  - paying + higher plan, other interval: new period from payment at full price
 *  - paying + lower plan / other interval: takes effect at the next renewal (no charge now)
 *  - Free: same as cancel at period end
 */
export async function startPlanCheckout(dataId: string, input: PlanChangeInput): Promise<CheckoutOutcome> {
  if (!isPlanKey(input.planKey)) throw new PlanError("unknown_plan", "Unknown plan.");
  if (!isBillingInterval(input.interval)) throw new PlanError("bad_interval", "Billing interval must be month or year.");
  const plan = PLANS[input.planKey];
  const sub = await getSubscription(dataId);
  const paid = isPaidSubscription(sub);

  if (plan.key === "free") {
    if (!paid) throw new PlanError("already_free", "You are already on the Free plan.", 409);
    const s = await cancelAtPeriodEnd(dataId);
    return { scheduled: true, effectiveAt: iso(s.current_period_end), note: "Your plan will move to Free at the end of the current period." };
  }
  if (!plan.selfServe) throw new PlanError("contact_sales", "Enterprise plans are arranged with our team.");

  const interval = input.interval as BillingInterval;
  const included = plan.entitlements.limits.seats ?? 1;
  const seats = Math.max(included, Math.trunc(input.seats ?? 0) || 0);

  const currency = paid ? sub.currency : (await getOrgSettings(dataId).catch(() => null))?.currency ?? "USD";
  const target = periodAmountMinor(plan, interval, currency, seats);
  const now = new Date();

  if (paid) {
    const cur = getPlan(sub.plan_key) ?? PLANS.free;
    const curInterval: BillingInterval = sub.billing_interval === "year" ? "year" : "month";
    if (plan.key === cur.key && interval === curInterval) {
      if (seats === Number(sub.seats_purchased)) throw new PlanError("no_change", "You are already on this plan.", 409);
      return changeSeats(dataId, seats);
    }
    if (target.currency !== sub.currency) throw new PlanError("currency_mismatch", `This subscription is billed in ${sub.currency}; contact support to change currency.`, 409);
    const end = new Date(sub.current_period_end as Date | string);
    const start = new Date((sub.current_period_start as Date | string | null) ?? now);
    if (plan.rank > cur.rank && interval === curInterval) {
      const charge = prorateUpgrade({ oldAmountMinor: currentPeriodAmount(sub), newAmountMinor: target.amountMinor, periodStart: start, periodEnd: end, now });
      if (charge > 0) {
        return createInvoiceAndCheckout(dataId, sub, { kind: "upgrade", planKey: plan.key, interval, seats, amountMinor: charge, currency: target.currency, description: `KernelHub ${plan.name} upgrade (prorated)`, periodStart: start, periodEnd: end });
      }
      // Nothing to charge (end of period): fall through to a full new period.
    }
    if (plan.rank > cur.rank) {
      return createInvoiceAndCheckout(dataId, sub, { kind: "subscribe", planKey: plan.key, interval, seats, amountMinor: target.amountMinor, currency: target.currency, description: `KernelHub ${plan.name} (${interval === "year" ? "annual" : "monthly"})`, periodStart: now, periodEnd: addMonthsClamped(now, interval === "year" ? 12 : 1) });
    }
    await schedule(dataId, { plan: plan.key, interval, seats });
    return { scheduled: true, effectiveAt: iso(sub.current_period_end), note: `${plan.name} starts at your next renewal. You keep your current plan until then.` };
  }

  return createInvoiceAndCheckout(dataId, sub, {
    kind: "subscribe",
    planKey: plan.key,
    interval,
    seats,
    amountMinor: target.amountMinor,
    currency: target.currency,
    description: `KernelHub ${plan.name} (${interval === "year" ? "annual" : "monthly"})`,
    periodStart: now,
    periodEnd: addMonthsClamped(now, interval === "year" ? 12 : 1),
  });
}

/** Change purchased seats: increases are charged pro rata now, decreases apply at renewal. */
export async function changeSeats(dataId: string, seats: number): Promise<CheckoutOutcome> {
  const sub = await getSubscription(dataId);
  if (!isPaidSubscription(sub)) throw new PlanError("no_paid_subscription", "Seats can be changed on a paid plan.", 409);
  const plan = getPlan(sub.plan_key);
  if (!plan || plan.entitlements.limits.seats === null) throw new PlanError("seats_not_applicable", "This plan has unlimited seats.", 409);
  const next = Math.trunc(seats);
  if (!Number.isFinite(next) || next < 1 || next > 1000) throw new PlanError("bad_seats", "Seats must be between 1 and 1000.");
  const interval: BillingInterval = sub.billing_interval === "year" ? "year" : "month";
  const target = Math.max(next, plan.entitlements.limits.seats);
  const cur = Number(sub.seats_purchased);
  if (target === cur) throw new PlanError("no_change", "Seats are unchanged.", 409);
  if (target < cur) {
    const used = await measure(dataId, "seats");
    if (target < used) throw new PlanError("seats_in_use", `${used} seats are in use; remove members before reducing seats.`, 409);
    await schedule(dataId, { plan: null, interval: null, seats: target });
    return { scheduled: true, effectiveAt: iso(sub.current_period_end), note: "The new seat count starts at your next renewal." };
  }
  const now = new Date();
  const start = new Date((sub.current_period_start as Date | string | null) ?? now);
  const end = new Date(sub.current_period_end as Date | string);
  const oldAmt = currentPeriodAmount(sub);
  const newAmt = periodAmountMinor(plan, interval, sub.currency, target).amountMinor;
  const charge = prorateUpgrade({ oldAmountMinor: oldAmt, newAmountMinor: newAmt, periodStart: start, periodEnd: end, now });
  return createInvoiceAndCheckout(dataId, sub, { kind: "seats", planKey: plan.key, interval, seats: target, amountMinor: Math.max(charge, 1), currency: sub.currency, description: `KernelHub ${plan.name} seats (${target})`, periodStart: start, periodEnd: end });
}

