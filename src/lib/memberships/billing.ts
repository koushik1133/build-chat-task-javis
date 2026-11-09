import { randomUUID } from "crypto";
import { query, queryOne } from "@/lib/dsql";
import { emitEvent } from "@/lib/events/bus";
import { createInvoice, getInvoice, recordPayment, type InvoiceDTO } from "@/lib/money/invoices";
import { getProvider } from "@/lib/payments";
import { logger } from "@/lib/log/logger";
import { formatMoney } from "@/lib/money/items";
import { expireSubscription, recordFailure } from "./dunning";
import { contactEmail, notifyMember, payUrlFor } from "./notify";
import { getPlanRowById as getPlanById, type PlanRow as PlanRowLite } from "./plans";
import { INCOMPLETE_EXPIRY_DAYS, RETRY_DAYS, TRIAL_REMINDER_DAYS, DAY_MS, advancePeriod, buildPeriodLines, isPlanInterval, periodLabel, type PlanInterval } from "./pure";
import { CHARGE_COLS, SUB_COLS, type ChargeRow, type SubRow } from "./store";

/**
 * Recurring billing engine.
 *
 *  - `billDue(limit)` (cron): claims subscriptions whose `next_charge_at` has passed with a conditional
 *    UPDATE (a 30 minute lease), then either bills the next period or runs the next dunning step.
 *  - One `subscription_charges` row per (subscription, period_start) is the idempotency gate: a second
 *    worker, a re-run or a crash between steps resumes the same charge and never creates a second invoice.
 *  - Payment is `chargeSaved` when the subscription holds a saved method, else the invoice pay link is emailed.
 *  - `onInvoicePaid` is called from the invoice paid transition (and again, idempotently, after a saved charge).
 */

const LEASE_MS = 30 * 60_000;

export interface BillResult {
  scanned: number;
  claimed: number;
  invoiced: number;
  paid: number;
  failed: number;
  cancelled: number;
  expired: number;
  errors: number;
}

const iso = (d: Date): string => d.toISOString();
const toDate = (v: string | Date): Date => new Date(v);

function anchorDayOf(sub: SubRow): number {
  return toDate(sub.trial_ends_at ?? sub.start_at).getUTCDate();
}

async function getChargeForPeriod(subId: string, periodStart: Date): Promise<ChargeRow | null> {
  return queryOne<ChargeRow>(`SELECT ${CHARGE_COLS} FROM subscription_charges WHERE subscription_id = $1 AND period_start = $2`, [subId, iso(periodStart)]);
}

/** Insert-or-load: the unique (subscription_id, period_start) index decides who owns this period. */
export async function claimCharge(dataId: string, sub: SubRow, periodStart: Date, periodEnd: Date, currency: string): Promise<{ charge: ChargeRow; created: boolean }> {
  const id = randomUUID();
  const rows = await query<ChargeRow>(
    `INSERT INTO subscription_charges (id, user_id, subscription_id, invoice_id, period_start, period_end, amount_minor, currency, status, attempt)
     VALUES ($1, $2, $3, NULL, $4, $5, 0, $6, 'pending', 0)
     ON CONFLICT (subscription_id, period_start) DO NOTHING RETURNING ${CHARGE_COLS}`,
    [id, dataId, sub.id, iso(periodStart), iso(periodEnd), currency]
  );
  if (rows[0]) return { charge: rows[0], created: true };
  const existing = await getChargeForPeriod(sub.id, periodStart);
  if (!existing) throw new Error("charge claim lost and no existing row");
  return { charge: existing, created: false };
}

export interface ChargeInvoiceInput {
  includePeriod: boolean;
  setupFeeMinor: number;
  adjustmentMinor: number;
  periodStart: Date;
  periodEnd: Date;
  now: Date;
}

/** Create + send the invoice for a charge (idempotent per charge). Returns null when there is nothing to bill. */
export async function issueChargeInvoice(dataId: string, sub: SubRow, plan: PlanRowLite, charge: ChargeRow, input: ChargeInvoiceInput): Promise<{ invoice: InvoiceDTO; adjustmentLeft: number } | null> {
  if (charge.invoice_id) {
    const inv = await getInvoice(dataId, charge.invoice_id);
    return inv ? { invoice: inv, adjustmentLeft: Number(sub.pending_adjustment_minor) } : null;
  }
  const interval: PlanInterval = isPlanInterval(plan.interval) ? plan.interval : "month";
  const { lines, adjustmentLeftMinor } = buildPeriodLines({
    planName: plan.name,
    label: periodLabel(interval, Number(plan.interval_count)),
    unitMinor: Number(plan.amount_minor),
    quantity: Number(sub.quantity),
    taxRateId: plan.tax_rate_id,
    productId: plan.product_id,
    setupFeeMinor: input.setupFeeMinor,
    adjustmentMinor: input.adjustmentMinor,
    includePeriod: input.includePeriod,
  });
  if (lines.length === 0) return null;
  const inv = await createInvoice(dataId, {
    contact_id: sub.contact_id,
    currency: plan.currency,
    items: lines.map((l) => ({ ...l, tax_rate_id: l.tax_rate_id ?? null })),
    due_at: iso(input.now),
    terms_days: 0,
    notes: `Membership: ${plan.name} (${input.periodStart.toISOString().slice(0, 10)} to ${input.periodEnd.toISOString().slice(0, 10)})`,
  });
  // Sent and due now so receivables and the pay link work. reminder_count is parked above the dunning
  // schedule: membership dunning owns follow-ups for these invoices.
  await query(
    `UPDATE invoices SET status = 'sent', sent_at = NOW(), reminder_count = 99, updated_at = NOW() WHERE id = $1 AND user_id = $2 AND status = 'draft'`,
    [inv.id, dataId]
  );
  await query(`UPDATE subscription_charges SET invoice_id = $2, amount_minor = $3, currency = $4 WHERE id = $1`, [charge.id, inv.id, inv.total_minor, plan.currency]);
  charge.invoice_id = inv.id;
  charge.amount_minor = inv.total_minor;
  const fresh = (await getInvoice(dataId, inv.id)) ?? inv;
  return { invoice: fresh, adjustmentLeft: adjustmentLeftMinor };
}

export type AttemptOutcome = "paid" | "failed" | "manual" | "already_paid";

/** One payment attempt for an open charge: saved method → chargeSaved; otherwise email the pay link. */
async function attemptPayment(dataId: string, sub: SubRow, plan: PlanRowLite, charge: ChargeRow): Promise<{ outcome: AttemptOutcome; error?: string }> {
  if (!charge.invoice_id) return { outcome: "failed", error: "no_invoice" };
  const inv = await getInvoice(dataId, charge.invoice_id);
  if (!inv) return { outcome: "failed", error: "invoice_missing" };
  if (inv.status === "paid") {
    await onInvoicePaid(dataId, inv.id);
    return { outcome: "already_paid" };
  }
  const outstanding = inv.total_minor - inv.paid_minor;
  const attempt = Number(charge.attempt) + 1;
  if (sub.payment_ref) {
    try {
      const provider = getProvider(sub.provider);
      const res = await provider.chargeSaved({
        paymentRef: sub.payment_ref,
        amountMinor: outstanding,
        currency: inv.currency,
        invoiceId: inv.id,
        description: `${plan.name} membership`,
        idempotencyKey: `${charge.id}:${attempt}`,
      });
      await query(`UPDATE subscription_charges SET attempt = $2, provider_ref = $3, error = $4 WHERE id = $1`, [charge.id, attempt, res.providerRef, res.error ?? null]);
      charge.attempt = attempt;
      if (res.status === "succeeded") {
        await recordPayment({ invoiceId: inv.id, provider: provider.id, providerRef: res.providerRef, amountMinor: outstanding, currency: inv.currency });
        await onInvoicePaid(dataId, inv.id);
        return { outcome: "paid" };
      }
      return { outcome: "failed", error: res.error ?? "charge_failed" };
    } catch (err) {
      return { outcome: "failed", error: err instanceof Error ? err.message : "charge_failed" };
    }
  }
  // Manual pay: the customer gets the invoice link.
  const url = await payUrlFor(dataId, inv.id);
  await notifyMember(dataId, sub.contact_id, {
    kind: "membership_invoice",
    subscriptionId: sub.id,
    subject: `Your ${plan.name} membership payment is due`,
    body: `Your payment of ${formatMoney(outstanding, inv.currency)} for ${plan.name} is due.${url ? `\n\nPay online: ${url}` : ""}\n\nTo pay automatically next time, add a payment method in your customer portal.`,
    extra: { pay_url: url },
  });
  await query(`UPDATE subscription_charges SET attempt = $2 WHERE id = $1`, [charge.id, attempt]);
  charge.attempt = attempt;
  return { outcome: "manual" };
}

async function claimDue(id: string, now: Date): Promise<SubRow | null> {
  const rows = await query<SubRow>(
    `UPDATE customer_subscriptions SET next_charge_at = $2, updated_at = NOW()
      WHERE id = $1 AND next_charge_at IS NOT NULL AND next_charge_at <= $3 AND status IN ('trialing', 'active', 'past_due', 'paused')
      RETURNING ${SUB_COLS}`,
    [id, iso(new Date(now.getTime() + LEASE_MS)), iso(now)]
  );
  return rows[0] ?? null;
}

type Tally = Omit<BillResult, "scanned" | "claimed" | "errors">;

/** Process one claimed subscription. Safe to re-enter after a crash at any step. */
async function processClaimed(sub: SubRow, now: Date, tally: Tally): Promise<void> {
  const dataId = sub.user_id;
  const plan = await getPlanById(sub.plan_id);
  if (!plan) {
    await query(`UPDATE customer_subscriptions SET next_charge_at = NULL WHERE id = $1`, [sub.id]);
    return;
  }

  if (sub.status === "paused") {
    if (sub.pause_until && toDate(sub.pause_until).getTime() <= now.getTime()) {
      await query(
        `UPDATE customer_subscriptions SET status = 'active', pause_until = NULL, current_period_end = $2, updated_at = NOW() WHERE id = $1 AND status = 'paused'`,
        [sub.id, iso(now)]
      );
      sub.status = "active";
      sub.pause_until = null;
      sub.current_period_end = now;
    } else {
      await query(`UPDATE customer_subscriptions SET next_charge_at = $2 WHERE id = $1`, [sub.id, sub.pause_until ? iso(toDate(sub.pause_until)) : null]);
      return;
    }
  }

  // Dunning step: an unpaid charge for the current period.
  if (sub.status !== "trialing" && sub.current_period_start) {
    const open = await getChargeForPeriod(sub.id, toDate(sub.current_period_start));
    if (open && open.status === "pending") {
      const res = await attemptPayment(dataId, sub, plan, open);
      if (res.outcome === "paid" || res.outcome === "already_paid") {
        tally.paid++;
        return;
      }
      const f = await recordFailure({ dataId, sub, charge: open, reason: res.error ?? "awaiting_payment", savedMethod: Boolean(sub.payment_ref), now, currency: plan.currency });
      if (f.outcome === "expired") tally.expired++;
      else tally.failed++;
      return;
    }
  }

  if (sub.cancel_at_period_end) {
    const done = await query<{ id: string }>(
      `UPDATE customer_subscriptions SET status = 'cancelled', cancelled_at = NOW(), next_charge_at = NULL, updated_at = NOW()
        WHERE id = $1 AND status NOT IN ('cancelled', 'expired') RETURNING id`,
      [sub.id]
    );
    if (done.length > 0) {
      tally.cancelled++;
      await emitEvent(dataId, { type: "membership.cancelled", entity: "subscription", entityId: sub.id, data: { contact_id: sub.contact_id, reason: "period_end", by: "customer" } });
      await notifyMember(dataId, sub.contact_id, { kind: "membership_cancelled", subscriptionId: sub.id, subject: "Your membership has ended", body: `Your ${plan.name} membership has ended as requested. Thank you for being a member.` });
    }
    return;
  }

  // New period.
  const periodStart = sub.current_period_end ? toDate(sub.current_period_end) : now;
  const interval: PlanInterval = isPlanInterval(plan.interval) ? plan.interval : "month";
  const periodEnd = advancePeriod(periodStart, interval, Number(plan.interval_count), anchorDayOf(sub));
  const { charge, created } = await claimCharge(dataId, sub, periodStart, periodEnd, plan.currency);
  if (!created && charge.status !== "pending") {
    // Someone already finished this period; make sure the subscription points at it.
    await query(
      `UPDATE customer_subscriptions SET current_period_start = $2, current_period_end = $3, next_charge_at = CASE WHEN status IN ('active', 'trialing') THEN $3 ELSE next_charge_at END, updated_at = NOW()
        WHERE id = $1 AND (current_period_start IS NULL OR current_period_start < $2)`,
      [sub.id, iso(periodStart), iso(periodEnd)]
    );
    return;
  }

  const made = await issueChargeInvoice(dataId, sub, plan, charge, { includePeriod: true, setupFeeMinor: 0, adjustmentMinor: Number(sub.pending_adjustment_minor), periodStart, periodEnd, now });
  if (!made) throw new Error("nothing to invoice");
  tally.invoiced++;
  const nextStatus = sub.status === "trialing" ? "active" : sub.status;
  await query(
    `UPDATE customer_subscriptions SET current_period_start = $2, current_period_end = $3, last_invoice_id = $4, status = $5, pending_adjustment_minor = $6, updated_at = NOW() WHERE id = $1`,
    [sub.id, iso(periodStart), iso(periodEnd), made.invoice.id, nextStatus, made.adjustmentLeft]
  );
  sub.current_period_start = periodStart;
  sub.current_period_end = periodEnd;
  sub.status = nextStatus;

  if (made.invoice.total_minor === 0) {
    // Free period: nothing to collect, so the charge is settled immediately.
    await query(`UPDATE subscription_charges SET status = 'paid' WHERE id = $1`, [charge.id]);
    await query(`UPDATE customer_subscriptions SET failed_attempts = 0, next_charge_at = $2, status = CASE WHEN status = 'past_due' THEN 'active' ELSE status END WHERE id = $1`, [sub.id, iso(periodEnd)]);
    await emitEvent(dataId, { type: "membership.renewed", entity: "subscription", entityId: sub.id, data: { contact_id: sub.contact_id, amount_minor: 0, period_end: iso(periodEnd) } });
    tally.paid++;
    return;
  }

  const res = await attemptPayment(dataId, sub, plan, charge);
  if (res.outcome === "paid" || res.outcome === "already_paid") {
    tally.paid++;
    return;
  }
  if (res.outcome === "manual") {
    // Awaiting the customer: first dunning check after the first retry day. Counts as attempt 1, silently.
    await query(`UPDATE customer_subscriptions SET failed_attempts = 1, next_charge_at = $2, updated_at = NOW() WHERE id = $1`, [sub.id, iso(new Date(Math.max(periodStart.getTime() + RETRY_DAYS[0] * DAY_MS, now.getTime() + 3_600_000)))]);
    return;
  }
  sub.failed_attempts = 0;
  const f = await recordFailure({ dataId, sub, charge, reason: res.error ?? "charge_failed", savedMethod: true, now, currency: plan.currency });
  if (f.outcome === "expired") tally.expired++;
  else tally.failed++;
}

export async function billDue(limit = 100, now: Date = new Date()): Promise<BillResult> {
  const cap = Math.min(Math.max(Math.floor(limit), 1), 500);
  const out: BillResult = { scanned: 0, claimed: 0, invoiced: 0, paid: 0, failed: 0, cancelled: 0, expired: 0, errors: 0 };
  const due = await query<{ id: string }>(
    `SELECT id FROM customer_subscriptions
      WHERE status IN ('trialing', 'active', 'past_due', 'paused') AND next_charge_at IS NOT NULL AND next_charge_at <= $1
      ORDER BY next_charge_at ASC LIMIT $2`,
    [iso(now), cap]
  );
  out.scanned = due.length;
  for (const d of due) {
    try {
      const sub = await claimDue(d.id, now);
      if (!sub) continue;
      out.claimed++;
      await processClaimed(sub, now, out);
    } catch (err) {
      out.errors++;
      logger.error("membership billing failed", { subscription_id: d.id, err: err instanceof Error ? err.message : String(err) });
    }
  }
  return out;
}

/** Staff "retry charge now": make the subscription due immediately and run one billing step for it. */
export async function billNow(dataId: string, subscriptionId: string, now: Date = new Date()): Promise<BillResult> {
  const out: BillResult = { scanned: 1, claimed: 0, invoiced: 0, paid: 0, failed: 0, cancelled: 0, expired: 0, errors: 0 };
  await query(
    `UPDATE customer_subscriptions SET next_charge_at = $3 WHERE id = $1 AND user_id = $2 AND status IN ('active', 'past_due') AND (next_charge_at IS NULL OR next_charge_at > $3)`,
    [subscriptionId, dataId, iso(new Date(now.getTime() - 1000))]
  );
  const sub = await claimDue(subscriptionId, now);
  if (!sub || sub.user_id !== dataId) return out;
  out.claimed = 1;
  try {
    await processClaimed(sub, now, out);
  } catch (err) {
    out.errors++;
    logger.error("membership retry failed", { subscription_id: subscriptionId, err: err instanceof Error ? err.message : String(err) });
  }
  return out;
}

/**
 * Hook from the invoice paid transition (and called again after a saved-card charge). Idempotent:
 * only the first call that flips the charge to `paid` updates the subscription and emits events.
 */
export async function onInvoicePaid(dataId: string, invoiceId: string): Promise<boolean> {
  const charge = await queryOne<ChargeRow>(`SELECT ${CHARGE_COLS} FROM subscription_charges WHERE invoice_id = $1 AND user_id = $2 ORDER BY created_at DESC LIMIT 1`, [invoiceId, dataId]);
  if (!charge) return false;
  const flipped = await query<{ id: string }>(`UPDATE subscription_charges SET status = 'paid', error = NULL WHERE id = $1 AND status IN ('pending', 'failed') RETURNING id`, [charge.id]);
  if (flipped.length === 0) return false;
  const sub = await queryOne<SubRow>(`SELECT ${SUB_COLS} FROM customer_subscriptions WHERE id = $1 AND user_id = $2`, [charge.subscription_id, dataId]);
  if (!sub) return false;

  const periodStart = toDate(charge.period_start);
  const periodEnd = toDate(charge.period_end);
  const isFirst = periodStart.getTime() === toDate(sub.start_at).getTime();
  const isCurrent = sub.current_period_start !== null && toDate(sub.current_period_start).getTime() === periodStart.getTime();
  const stillTrial = sub.status === "trialing" && sub.trial_ends_at !== null && periodEnd.getTime() <= toDate(sub.trial_ends_at).getTime();
  const reactivate = sub.status === "incomplete" || (sub.status === "expired" && sub.cancelled_at === null);
  let next = sub.status;
  if (stillTrial) next = "trialing";
  else if (sub.status === "cancelled" || sub.status === "paused" || (sub.status === "expired" && !reactivate)) next = sub.status;
  else next = "active";

  await query(
    `UPDATE customer_subscriptions SET status = $2::text, failed_attempts = CASE WHEN $4::boolean THEN 0 ELSE failed_attempts END,
            next_charge_at = CASE WHEN $4::boolean AND $2::text IN ('active', 'trialing') THEN $3::timestamptz ELSE next_charge_at END, updated_at = NOW()
      WHERE id = $1`,
    [sub.id, next, sub.current_period_end ? iso(toDate(sub.current_period_end)) : iso(periodEnd), isCurrent]
  );

  const plan = await getPlanById(sub.plan_id);
  if (isFirst) {
    await notifyMember(dataId, sub.contact_id, {
      kind: "membership_welcome",
      subscriptionId: sub.id,
      subject: `Welcome to ${plan?.name ?? "your membership"}`,
      body: `Your payment was received and your ${plan?.name ?? ""} membership is active.${sub.current_period_end ? ` Your next payment is due ${toDate(sub.current_period_end).toDateString()}.` : ""}`,
    });
  } else {
    await emitEvent(dataId, {
      type: "membership.renewed",
      entity: "subscription",
      entityId: sub.id,
      data: { contact_id: sub.contact_id, amount_minor: Number(charge.amount_minor), currency: charge.currency, period_start: iso(periodStart), period_end: iso(periodEnd), recovered: sub.status === "past_due" },
    });
  }
  return true;
}

export interface SweepResult {
  trial_reminders: number;
  incomplete_expired: number;
}

/** Trial-ending reminders (3 days out, once) and expiry of sign-ups that never paid. */
export async function sweepExpiring(limit = 100, now: Date = new Date()): Promise<SweepResult> {
  const cap = Math.min(Math.max(Math.floor(limit), 1), 500);
  const out: SweepResult = { trial_reminders: 0, incomplete_expired: 0 };

  const trials = await query<SubRow>(
    `SELECT ${SUB_COLS} FROM customer_subscriptions
      WHERE status = 'trialing' AND trial_reminder_at IS NULL AND trial_ends_at IS NOT NULL AND trial_ends_at > $1 AND trial_ends_at <= $2
      ORDER BY trial_ends_at ASC LIMIT $3`,
    [iso(now), iso(new Date(now.getTime() + TRIAL_REMINDER_DAYS * DAY_MS)), cap]
  );
  for (const t of trials) {
    const claimed = await query<{ id: string }>(`UPDATE customer_subscriptions SET trial_reminder_at = $2 WHERE id = $1 AND trial_reminder_at IS NULL RETURNING id`, [t.id, iso(now)]);
    if (claimed.length === 0) continue;
    const plan = await getPlanById(t.plan_id);
    const endsAt = toDate(t.trial_ends_at ?? now);
    out.trial_reminders++;
    const who = await contactEmail(t.user_id, t.contact_id);
    await emitEvent(t.user_id, {
      type: "membership.trial_ending",
      entity: "subscription",
      entityId: t.id,
      data: { contact_id: t.contact_id, to: who.email, name: who.name, plan: plan?.name ?? null, trial_ends_at: iso(endsAt), amount_minor: plan ? Number(plan.amount_minor) * Number(t.quantity) : null, currency: plan?.currency ?? null, has_payment_method: Boolean(t.payment_ref) },
    });
    await notifyMember(t.user_id, t.contact_id, {
      kind: "membership_trial_ending",
      subscriptionId: t.id,
      subject: `Your ${plan?.name ?? "membership"} trial ends soon`,
      body: `Your free trial ends on ${endsAt.toDateString()}. ${plan ? `After that you will be charged ${formatMoney(Number(plan.amount_minor) * Number(t.quantity), plan.currency)}.` : ""}${t.payment_ref ? "" : " Add a payment method in your customer portal to continue without interruption."} You can cancel any time before then.`,
    });
  }

  const stale = await query<SubRow>(
    `SELECT ${SUB_COLS} FROM customer_subscriptions WHERE status = 'incomplete' AND created_at < $1 ORDER BY created_at ASC LIMIT $2`,
    [iso(new Date(now.getTime() - INCOMPLETE_EXPIRY_DAYS * DAY_MS)), cap]
  );
  for (const s of stale) {
    const flipped = await query<{ id: string }>(`UPDATE customer_subscriptions SET status = 'expired', next_charge_at = NULL, updated_at = NOW() WHERE id = $1 AND status = 'incomplete' RETURNING id`, [s.id]);
    if (flipped.length === 0) continue;
    out.incomplete_expired++;
    const charge = await queryOne<ChargeRow>(`SELECT ${CHARGE_COLS} FROM subscription_charges WHERE subscription_id = $1 ORDER BY period_start ASC LIMIT 1`, [s.id]);
    if (charge) {
      await query(`UPDATE subscription_charges SET status = 'void' WHERE id = $1 AND status = 'pending'`, [charge.id]);
      if (charge.invoice_id) {
        const { voidInvoice } = await import("@/lib/money/invoices");
        await voidInvoice(s.user_id, charge.invoice_id).catch(() => undefined);
      }
    }
  }
  return out;
}

export { expireSubscription };
