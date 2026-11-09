import { z } from "zod";
import { query } from "@/lib/dsql";
import { createPayLink } from "@/lib/money/invoices";
import { issueShareToken } from "@/lib/share-tokens";
import { MembershipError, getPlanRowById } from "./plans";
import { cancelSubscription, keepSubscription, pauseSubscription, resumeSubscription, setPaymentMethod } from "./subscriptions";
import { getSubRow } from "./store";
import { parseBenefits, type PlanBenefit, type PlanInterval, type SubStatus } from "./pure";
import { simulatedPaymentsAllowed, activeProviderId } from "@/lib/payments";

/** Portal read model + self-service actions. Everything is scoped to (org, contact) from the portal token. */

export interface PortalMembershipInvoice {
  id: string;
  number: string;
  status: string;
  totalMinor: number;
  currency: string;
  createdAt: string;
  path: string | null;
}
export interface PortalMembership {
  id: string;
  planName: string;
  status: SubStatus;
  quantity: number;
  amountMinor: number;
  currency: string;
  interval: PlanInterval;
  intervalCount: number;
  nextChargeAt: string | null;
  currentPeriodEnd: string | null;
  trialEndsAt: string | null;
  cancelAtPeriodEnd: boolean;
  pauseUntil: string | null;
  hasPaymentMethod: boolean;
  canPause: boolean;
  canCancel: boolean;
  canResume: boolean;
  /** The simulated provider lets the portal put a test card on file. */
  simulatedPaymentMethod: boolean;
  benefits: PlanBenefit[];
  /** Pay link for an unpaid membership invoice. */
  payUrl: string | null;
  invoices: PortalMembershipInvoice[];
}

const iso = (v: string | Date | null): string | null => (v ? new Date(v).toISOString() : null);

export async function portalMemberships(dataId: string, contactId: string, opts: { issueLinks?: boolean } = {}): Promise<PortalMembership[]> {
  const rows = await query<{
    id: string; plan_id: string; status: string; quantity: number; amount_minor: string | number; currency: string; interval: string; interval_count: number;
    name: string; benefits: string | null; allow_pause: boolean; next_charge_at: string | Date | null; current_period_end: string | Date | null; trial_ends_at: string | Date | null;
    cancel_at_period_end: boolean; pause_until: string | Date | null; payment_ref: string | null; last_invoice_id: string | null;
  }>(
    `SELECT s.id, s.plan_id, s.status, s.quantity, p.amount_minor, p.currency, p.interval, p.interval_count, p.name, p.benefits, p.allow_pause,
            s.next_charge_at, s.current_period_end, s.trial_ends_at, s.cancel_at_period_end, s.pause_until, s.payment_ref, s.last_invoice_id
       FROM customer_subscriptions s JOIN membership_plans p ON p.id = s.plan_id
      WHERE s.user_id = $1 AND s.contact_id = $2 AND s.status <> 'incomplete' ORDER BY s.created_at DESC LIMIT 20`,
    [dataId, contactId]
  );
  const sim = activeProviderId() === "simulated" && simulatedPaymentsAllowed();
  const out: PortalMembership[] = [];
  for (const r of rows) {
    const invs = await query<{ id: string; number: string; status: string; total_minor: string | number; currency: string; created_at: string | Date }>(
      `SELECT i.id, i.number, i.status, i.total_minor, i.currency, i.created_at FROM subscription_charges c JOIN invoices i ON i.id = c.invoice_id
        WHERE c.subscription_id = $1 AND c.user_id = $2 ORDER BY c.period_start DESC LIMIT 12`,
      [r.id, dataId]
    );
    const invoices: PortalMembershipInvoice[] = [];
    for (const i of invs) {
      let path: string | null = null;
      if (opts.issueLinks) path = await issueShareToken(dataId, "invoice", i.id, 14).then((t) => t.path).catch(() => null);
      invoices.push({ id: i.id, number: i.number, status: i.status, totalMinor: Number(i.total_minor), currency: i.currency, createdAt: new Date(i.created_at).toISOString(), path });
    }
    const unpaid = invs.find((i) => i.id === r.last_invoice_id && i.status !== "paid" && i.status !== "void");
    let payUrl: string | null = null;
    if (unpaid && opts.issueLinks) payUrl = await createPayLink(dataId, unpaid.id).then((l) => l.url).catch(() => null);
    const ended = r.status === "cancelled" || r.status === "expired";
    out.push({
      id: r.id,
      planName: r.name,
      status: r.status as SubStatus,
      quantity: Number(r.quantity),
      amountMinor: Number(r.amount_minor),
      currency: r.currency,
      interval: r.interval as PlanInterval,
      intervalCount: Number(r.interval_count),
      nextChargeAt: iso(r.next_charge_at),
      currentPeriodEnd: iso(r.current_period_end),
      trialEndsAt: iso(r.trial_ends_at),
      cancelAtPeriodEnd: Boolean(r.cancel_at_period_end),
      pauseUntil: iso(r.pause_until),
      hasPaymentMethod: Boolean(r.payment_ref),
      canPause: Boolean(r.allow_pause) && r.status === "active",
      canCancel: !ended && !r.cancel_at_period_end,
      canResume: r.status === "paused",
      simulatedPaymentMethod: sim && !ended,
      benefits: parseBenefits(r.benefits),
      payUrl,
      invoices,
    });
  }
  return out;
}

export const PortalActionSchema = z
  .object({
    action: z.enum(["cancel", "keep", "pause", "resume", "update_payment_method"]),
    subscription_id: z.string().min(1).max(100),
    /** pause: ISO date the membership resumes; omitted = until the customer resumes. */
    until: z.string().max(40).optional(),
    /** update_payment_method with the simulated provider. */
    simulate: z.enum(["ok", "decline"]).optional(),
  })
  .strict();
export type PortalAction = z.infer<typeof PortalActionSchema>;

/** Run a customer action on one of THEIR subscriptions. A subscription of anyone else is indistinguishable from a missing one. */
export async function runPortalAction(dataId: string, contactId: string, input: PortalAction): Promise<void> {
  const sub = await getSubRow(dataId, input.subscription_id);
  if (!sub || sub.contact_id !== contactId) throw new MembershipError("not_found", "Membership not found", 404);
  switch (input.action) {
    case "cancel":
      await cancelSubscription(dataId, sub.id, { atPeriodEnd: true, by: "customer", reason: "customer_request" });
      return;
    case "keep":
      await keepSubscription(dataId, sub.id);
      return;
    case "pause": {
      const plan = await getPlanRowById(sub.plan_id);
      if (!plan?.allow_pause) throw new MembershipError("pause_not_allowed", "This plan cannot be paused", 403);
      const until = input.until ? new Date(input.until) : null;
      if (until && Number.isNaN(until.getTime())) throw new MembershipError("invalid_date", "Invalid date");
      if (until && until.getTime() > Date.now() + 365 * 86_400_000) throw new MembershipError("invalid_date", "Pause for at most a year");
      await pauseSubscription(dataId, sub.id, { until });
      return;
    }
    case "resume":
      await resumeSubscription(dataId, sub.id);
      return;
    case "update_payment_method":
      await setPaymentMethod(dataId, sub.id, { simulate: input.simulate });
      return;
  }
}
