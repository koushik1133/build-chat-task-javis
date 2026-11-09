import { randomBytes, randomUUID } from "crypto";
import { z } from "zod";
import { query, queryOne } from "@/lib/dsql";
import { emitEvent } from "@/lib/events/bus";
import { createPayLink, voidInvoice } from "@/lib/money/invoices";
import { activeProviderId, getProvider, simulatedPaymentsAllowed } from "@/lib/payments";
import { hashToken } from "@/lib/share-tokens";
import { recordConsent, type ConsentEvidence } from "@/lib/privacy/consent";
import { logger } from "@/lib/log/logger";
import { claimCharge, issueChargeInvoice, onInvoicePaid } from "./billing";
import { notifyMember } from "./notify";
import { MembershipError, getPlanBySlug, getPlanRowById, seatsUsed, type PlanDTO, type PlanRow } from "./plans";
import { ACCESS_STATUSES, advancePeriod, membershipMetrics, prorate, type MembershipMetrics, type MetricRow, type PlanInterval, type SubStatus } from "./pure";
import { SUB_COLS, getSubRow, getSubscription, type SubRow, type SubscriptionDTO } from "./store";

const DAY_MS = 86_400_000;
const iso = (d: Date): string => d.toISOString();
const toDate = (v: string | Date): Date => new Date(v);

export const SubscribeSchema = z
  .object({
    contact: z
      .object({
        name: z.string().trim().min(1).max(200),
        email: z.string().trim().toLowerCase().email().max(320),
        phone: z.string().trim().max(40).optional(),
      })
      .strict(),
    quantity: z.number().int().min(1).max(100).default(1),
    consent: z.object({ terms: z.literal(true), marketing: z.boolean().optional() }).strict(),
  })
  .strict();
export type SubscribeInput = z.infer<typeof SubscribeSchema>;

export interface SubscribeResult {
  subscription_id: string;
  status: SubStatus;
  /** Where to send the customer to pay (first invoice), or null for a free trial / free plan. */
  pay_url: string | null;
  trial_ends_at: string | null;
  join_token: string;
}

/**
 * Find a contact by email or create one tagged "membership". An existing contact is reused for the
 * subscription but its consent ledger is never touched: an unverified email address proves nothing.
 */
async function matchOrCreateContact(dataId: string, c: { name: string; email: string; phone?: string | null }): Promise<{ id: string; created: boolean }> {
  const existing = await queryOne<{ id: string }>(
    `SELECT id FROM crm_contacts WHERE user_id = $1 AND lower(email) = $2 AND deleted_at IS NULL ORDER BY created_at ASC LIMIT 1`,
    [dataId, c.email]
  );
  if (existing) return { id: existing.id, created: false };
  const id = randomUUID();
  await query(
    `INSERT INTO crm_contacts (id, user_id, domain, full_name, email, phone, tags, lifecycle, notes, last_contact)
     VALUES ($1, $2, 'general', $3, $4, $5, '["membership"]', 'customer', NULL, NOW())`,
    [id, dataId, c.name.trim().slice(0, 200), c.email, c.phone?.trim() || null]
  );
  void emitEvent(dataId, { type: "crm.contact.created", entity: "contact", entityId: id, data: { source: "membership" } });
  return { id, created: true };
}

/** Public sign-up: contact + subscription + first invoice (setup fee + first period) + pay link. */
export async function subscribe(dataId: string, planSlug: string, input: SubscribeInput, evidence: ConsentEvidence = {}, now: Date = new Date()): Promise<SubscribeResult> {
  const plan = await getPlanBySlug(dataId, planSlug);
  if (!plan || !plan.active) throw new MembershipError("plan_unavailable", "This plan is not available", 404);
  if (input.quantity > 1 && !plan.allow_quantity) throw new MembershipError("quantity_not_allowed", "This plan is sold one at a time");
  if (plan.max_members !== null && (await seatsUsed(plan.id)) >= plan.max_members) throw new MembershipError("plan_full", "This plan is full", 409);

  const contact = await matchOrCreateContact(dataId, input.contact);
  if (contact.created && input.consent.marketing !== undefined) {
    void recordConsent(dataId, { kind: "contact", id: contact.id }, "marketing_email", input.consent.marketing ? "granted" : "withdrawn", "form", { ...evidence, text: "Membership sign-up" }).catch(() => undefined);
  }

  // A repeat submit while the first sign-up is still unpaid resumes it instead of piling up duplicates.
  const open = await queryOne<SubRow>(
    `SELECT ${SUB_COLS} FROM customer_subscriptions WHERE user_id = $1 AND plan_id = $2 AND contact_id = $3 AND status = 'incomplete' ORDER BY created_at DESC LIMIT 1`,
    [dataId, plan.id, contact.id]
  );
  const token = randomBytes(18).toString("base64url");
  const planRow = await getPlanRowById(plan.id);
  if (!planRow) throw new MembershipError("plan_unavailable", "This plan is not available", 404);

  if (open) {
    const charge = await queryOne<{ invoice_id: string | null }>(`SELECT invoice_id FROM subscription_charges WHERE subscription_id = $1 ORDER BY period_start ASC LIMIT 1`, [open.id]);
    const payUrl = charge?.invoice_id ? (await createPayLink(dataId, charge.invoice_id).catch(() => null))?.url ?? null : null;
    if (payUrl) {
      await query(`UPDATE customer_subscriptions SET join_token_hash = $2, updated_at = NOW() WHERE id = $1`, [open.id, hashToken(token)]);
      return { subscription_id: open.id, status: "incomplete", pay_url: payUrl, trial_ends_at: null, join_token: token };
    }
  }

  const id = randomUUID();
  // One trial per (contact, plan): a repeat sign-up with the same email starts billing immediately instead of restarting the trial.
  const priorTrial = plan.trial_days > 0 ? await queryOne(`SELECT id FROM customer_subscriptions WHERE user_id = $1 AND plan_id = $2 AND contact_id = $3 AND trial_ends_at IS NOT NULL LIMIT 1`, [dataId, plan.id, contact.id]) : null;
  const trial = plan.trial_days > 0 && !priorTrial;
  const trialEnd = trial ? new Date(now.getTime() + plan.trial_days * DAY_MS) : null;
  const periodEnd = trialEnd ?? advancePeriod(now, plan.interval, plan.interval_count, now.getUTCDate());
  const provider = activeProviderId();
  await query(
    `INSERT INTO customer_subscriptions (id, user_id, plan_id, contact_id, status, quantity, start_at, trial_ends_at, current_period_start, current_period_end, next_charge_at,
       cancel_at_period_end, payment_ref, provider, failed_attempts, pending_adjustment_minor, join_token_hash)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$7,$9,$10,FALSE,NULL,$11,0,0,$12)`,
    [id, dataId, plan.id, contact.id, trial ? "trialing" : "incomplete", input.quantity, iso(now), trialEnd ? iso(trialEnd) : null, iso(periodEnd), trialEnd ? iso(trialEnd) : null, provider, hashToken(token)]
  );
  const sub = await getSubRow(dataId, id);
  if (!sub) throw new Error("Subscription vanished after insert");

  let payUrl: string | null = null;
  const setupFee = plan.setup_fee_minor;
  // Trial: only a setup fee is billed now. No trial: setup fee + the first period.
  if (!trial || setupFee > 0) {
    const { charge } = await claimCharge(dataId, sub, now, periodEnd, plan.currency);
    const made = await issueChargeInvoice(dataId, sub, planRow, charge, { includePeriod: !trial, setupFeeMinor: setupFee, adjustmentMinor: 0, periodStart: now, periodEnd, now });
    if (made && made.invoice.total_minor > 0) {
      await query(`UPDATE customer_subscriptions SET last_invoice_id = $2 WHERE id = $1`, [id, made.invoice.id]);
      payUrl = (await createPayLink(dataId, made.invoice.id)).url;
    } else if (made) {
      // Free plan: nothing to pay, the membership starts now.
      await query(`UPDATE subscription_charges SET status = 'paid' WHERE id = $1`, [charge.id]);
      await query(`UPDATE customer_subscriptions SET status = 'active', next_charge_at = $2, last_invoice_id = $3 WHERE id = $1 AND status = 'incomplete'`, [id, iso(periodEnd), made.invoice.id]);
    }
  }
  const status: SubStatus = trial ? "trialing" : payUrl ? "incomplete" : "active";
  await emitEvent(dataId, {
    type: "membership.subscribed",
    entity: "subscription",
    entityId: id,
    data: { contact_id: contact.id, plan_id: plan.id, plan_slug: plan.slug, plan: plan.name, quantity: input.quantity, trial_ends_at: trialEnd ? iso(trialEnd) : null, amount_minor: plan.amount_minor * input.quantity, currency: plan.currency },
  });
  if (trial) {
    await notifyMember(dataId, contact.id, {
      kind: "membership_trial_started",
      subscriptionId: id,
      subject: `Your ${plan.name} trial has started`,
      body: `Your free trial runs until ${trialEnd?.toDateString()}. We will remind you before it ends.`,
    });
  }
  return { subscription_id: id, status, pay_url: payUrl, trial_ends_at: trialEnd ? iso(trialEnd) : null, join_token: token };
}

/* ── lifecycle actions ────────────────────────────────────────────────────── */

async function mustGet(dataId: string, id: string): Promise<SubRow> {
  const sub = await getSubRow(dataId, id);
  if (!sub) throw new MembershipError("not_found", "Subscription not found", 404);
  return sub;
}

export interface CancelOpts {
  /** Keep access until the paid period ends (default). `false` ends the membership now. */
  atPeriodEnd?: boolean;
  by?: "staff" | "customer" | "system";
  reason?: string | null;
}

export async function cancelSubscription(dataId: string, id: string, opts: CancelOpts = {}): Promise<SubscriptionDTO> {
  const sub = await mustGet(dataId, id);
  if (sub.status === "cancelled" || sub.status === "expired") throw new MembershipError("already_ended", "This membership has already ended", 409);
  const by = opts.by ?? "staff";
  const immediate = opts.atPeriodEnd === false || sub.status === "incomplete" || sub.status === "paused";
  if (immediate) {
    await query(`UPDATE customer_subscriptions SET status = 'cancelled', cancelled_at = NOW(), cancel_at_period_end = FALSE, next_charge_at = NULL, pause_until = NULL, updated_at = NOW() WHERE id = $1 AND user_id = $2`, [id, dataId]);
    // An unpaid invoice for a membership that no longer exists must stop chasing the customer.
    const open = await queryOne<{ id: string; invoice_id: string | null }>(`SELECT id, invoice_id FROM subscription_charges WHERE subscription_id = $1 AND status = 'pending' ORDER BY period_start DESC LIMIT 1`, [id]);
    if (open) {
      await query(`UPDATE subscription_charges SET status = 'void' WHERE id = $1 AND status = 'pending'`, [open.id]);
      if (open.invoice_id) await voidInvoice(dataId, open.invoice_id).catch(() => undefined);
    }
    await emitEvent(dataId, { type: "membership.cancelled", entity: "subscription", entityId: id, data: { contact_id: sub.contact_id, reason: opts.reason ?? "cancelled", by, immediate: true } });
  } else {
    await query(`UPDATE customer_subscriptions SET cancel_at_period_end = TRUE, updated_at = NOW() WHERE id = $1 AND user_id = $2`, [id, dataId]);
    await emitEvent(dataId, { type: "membership.cancelled", entity: "subscription", entityId: id, data: { contact_id: sub.contact_id, reason: opts.reason ?? "cancel_at_period_end", by, immediate: false, ends_at: sub.current_period_end ? toDate(sub.current_period_end).toISOString() : null } });
  }
  return (await getSubscription(dataId, id)) as SubscriptionDTO;
}

/** Undo "cancel at period end" before the period closes. */
export async function keepSubscription(dataId: string, id: string): Promise<SubscriptionDTO> {
  const sub = await mustGet(dataId, id);
  if (sub.status === "cancelled" || sub.status === "expired") throw new MembershipError("already_ended", "This membership has already ended", 409);
  await query(`UPDATE customer_subscriptions SET cancel_at_period_end = FALSE, updated_at = NOW() WHERE id = $1 AND user_id = $2`, [id, dataId]);
  return (await getSubscription(dataId, id)) as SubscriptionDTO;
}

export async function pauseSubscription(dataId: string, id: string, opts: { until?: Date | null; enforcePlan?: boolean } = {}, now: Date = new Date()): Promise<SubscriptionDTO> {
  const sub = await mustGet(dataId, id);
  if (sub.status !== "active" || Number(sub.failed_attempts) > 0) throw new MembershipError("cannot_pause", "Only an active, up-to-date membership can be paused", 409);
  if (opts.enforcePlan) {
    const plan = await getPlanRowById(sub.plan_id);
    if (!plan?.allow_pause) throw new MembershipError("pause_not_allowed", "This plan cannot be paused", 403);
  }
  if (opts.until && opts.until.getTime() <= now.getTime()) throw new MembershipError("invalid_date", "Pause end must be in the future");
  await query(
    `UPDATE customer_subscriptions SET status = 'paused', pause_until = $3, next_charge_at = $3, updated_at = NOW() WHERE id = $1 AND user_id = $2 AND status = 'active'`,
    [id, dataId, opts.until ? iso(opts.until) : null]
  );
  await emitEvent(dataId, { type: "membership.paused", entity: "subscription", entityId: id, data: { contact_id: sub.contact_id, until: opts.until ? iso(opts.until) : null } });
  return (await getSubscription(dataId, id)) as SubscriptionDTO;
}

/** Resume starts a fresh billing period now; time left on the interrupted period is forfeited. */
export async function resumeSubscription(dataId: string, id: string, now: Date = new Date()): Promise<SubscriptionDTO> {
  const sub = await mustGet(dataId, id);
  if (sub.status !== "paused") throw new MembershipError("not_paused", "This membership is not paused", 409);
  await query(
    `UPDATE customer_subscriptions SET status = 'active', pause_until = NULL, current_period_end = $3, next_charge_at = $3, updated_at = NOW() WHERE id = $1 AND user_id = $2 AND status = 'paused'`,
    [id, dataId, iso(now)]
  );
  return (await getSubscription(dataId, id)) as SubscriptionDTO;
}

export interface ChangeInput {
  planSlug?: string;
  quantity?: number;
}

/** Switch plan and/or quantity. The unused part of the paid period is credited against the new price on the next invoice. */
export async function changeSubscription(dataId: string, id: string, input: ChangeInput, now: Date = new Date()): Promise<{ subscription: SubscriptionDTO; proration_minor: number }> {
  const sub = await mustGet(dataId, id);
  if (!["active", "trialing", "past_due"].includes(sub.status)) throw new MembershipError("cannot_change", "This membership cannot be changed in its current state", 409);
  const oldPlan = await getPlanRowById(sub.plan_id);
  if (!oldPlan) throw new MembershipError("not_found", "Plan not found", 404);
  let newPlan: PlanRow | PlanDTO = oldPlan;
  if (input.planSlug) {
    const p = await getPlanBySlug(dataId, input.planSlug);
    if (!p || !p.active) throw new MembershipError("plan_unavailable", "That plan is not available", 404);
    if (p.currency !== oldPlan.currency) throw new MembershipError("currency_mismatch", "Plans in a different currency cannot be switched in place");
    if (p.id !== sub.plan_id && p.max_members !== null && (await seatsUsed(p.id)) >= p.max_members) throw new MembershipError("plan_full", "That plan is full", 409);
    newPlan = p;
  }
  const newQty = input.quantity ?? Number(sub.quantity);
  if (!Number.isInteger(newQty) || newQty < 1 || newQty > 100) throw new MembershipError("invalid_quantity", "Quantity must be between 1 and 100");

  let net = 0;
  // Only a paid, running period earns a proration; during a trial or with an unpaid invoice the new price just applies from the next charge.
  const lastPaid = sub.current_period_start && sub.current_period_end && sub.status === "active" && Number(sub.failed_attempts) === 0;
  if (lastPaid && sub.current_period_start && sub.current_period_end) {
    net = prorate({
      oldUnitMinor: Number(oldPlan.amount_minor),
      oldQty: Number(sub.quantity),
      newUnitMinor: Number(newPlan.amount_minor),
      newQty,
      periodStart: toDate(sub.current_period_start),
      periodEnd: toDate(sub.current_period_end),
      now,
    }).netMinor;
  }
  await query(
    `UPDATE customer_subscriptions SET plan_id = $3, quantity = $4, pending_adjustment_minor = pending_adjustment_minor + $5, updated_at = NOW() WHERE id = $1 AND user_id = $2`,
    [id, dataId, newPlan.id, newQty, net]
  );
  return { subscription: (await getSubscription(dataId, id)) as SubscriptionDTO, proration_minor: net };
}

/**
 * Put a payment method on file for the subscription. The simulated provider takes a test-card choice
 * (and is blocked in production unless PAYMENTS_ALLOW_SIMULATED=true); real providers use a hosted setup page.
 */
export async function setPaymentMethod(dataId: string, id: string, opts: { simulate?: "ok" | "decline" } = {}, now: Date = new Date()): Promise<SubscriptionDTO> {
  const sub = await mustGet(dataId, id);
  if (sub.status === "cancelled" || sub.status === "expired") throw new MembershipError("already_ended", "This membership has already ended", 409);
  const provider = getProvider();
  if (provider.id === "simulated" && !simulatedPaymentsAllowed()) throw new MembershipError("not_available", "Saving a payment method is not available here", 403);
  try {
    const c = await queryOne<{ full_name: string | null; email: string | null }>(`SELECT full_name, email FROM crm_contacts WHERE id = $1 AND user_id = $2`, [sub.contact_id, dataId]);
    const { customerRef } = await provider.createCustomer({ contactId: sub.contact_id, email: c?.email ?? null, name: c?.full_name ?? "Customer" });
    const { paymentRef } = await provider.attachPaymentMethod({ customerRef, simulate: opts.simulate });
    // A past-due membership retries straight away with the new method.
    await query(
      `UPDATE customer_subscriptions SET payment_ref = $3, provider = $4,
              next_charge_at = CASE WHEN status = 'past_due' THEN $5::timestamptz ELSE next_charge_at END, updated_at = NOW()
        WHERE id = $1 AND user_id = $2`,
      [id, dataId, paymentRef, provider.id, iso(now)]
    );
  } catch (err) {
    if (err instanceof MembershipError) throw err;
    logger.warn("payment method update failed", { err: err instanceof Error ? err.message : String(err) });
    throw new MembershipError("provider_unavailable", err instanceof Error ? err.message : "Payment provider is unavailable", 501);
  }
  return (await getSubscription(dataId, id)) as SubscriptionDTO;
}

/* ── access + analytics ───────────────────────────────────────────────────── */

/**
 * Does this contact hold a membership that grants access right now? Trialing, active and past-due
 * (grace period before the final retry) count; paused, cancelled and expired do not. Pass a plan slug to
 * check one plan. Never throws: false when the module's tables are missing.
 */
export async function hasActiveMembership(dataId: string, contactId: string, planSlug?: string): Promise<boolean> {
  try {
    const params: unknown[] = [dataId, contactId, [...ACCESS_STATUSES]];
    let sql = `SELECT 1 AS ok FROM customer_subscriptions s JOIN membership_plans p ON p.id = s.plan_id WHERE s.user_id = $1 AND s.contact_id = $2 AND s.status = ANY($3::text[])`;
    if (planSlug) {
      params.push(planSlug);
      sql += ` AND p.slug = $4`;
    }
    return Boolean(await queryOne(`${sql} LIMIT 1`, params));
  } catch {
    return false;
  }
}

export async function loadMetrics(dataId: string, now: Date = new Date()): Promise<MembershipMetrics> {
  const rows = await query<{
    status: string; amount_minor: string | number; quantity: number; interval: string; interval_count: number; currency: string;
    start_at: string | Date; cancelled_at: string | Date | null; trial_ends_at: string | Date | null; converted: boolean;
  }>(
    `SELECT s.status, p.amount_minor, s.quantity, p.interval, p.interval_count, p.currency, s.start_at, s.cancelled_at, s.trial_ends_at,
            EXISTS (SELECT 1 FROM subscription_charges c WHERE c.subscription_id = s.id AND c.status = 'paid' AND (s.trial_ends_at IS NULL OR c.period_start >= s.trial_ends_at)) AS converted
       FROM customer_subscriptions s JOIN membership_plans p ON p.id = s.plan_id WHERE s.user_id = $1 LIMIT 20000`,
    [dataId]
  );
  const metricRows: MetricRow[] = rows.map((r) => ({
    status: r.status as SubStatus,
    amount_minor: Number(r.amount_minor),
    quantity: Number(r.quantity),
    interval: r.interval as PlanInterval,
    interval_count: Number(r.interval_count),
    currency: r.currency,
    start_at: r.start_at,
    cancelled_at: r.cancelled_at,
    trial_ends_at: r.trial_ends_at,
    converted: Boolean(r.converted),
  }));
  return membershipMetrics(metricRows, now);
}

export { onInvoicePaid };
