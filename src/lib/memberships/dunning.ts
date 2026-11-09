import { query } from "@/lib/dsql";
import { emitEvent } from "@/lib/events/bus";
import { voidInvoice } from "@/lib/money/invoices";
import { formatMoney } from "@/lib/money/items";
import { logger } from "@/lib/log/logger";
import { contactEmail, notifyMember, payUrlFor } from "./notify";
import { dunningStep, statusAfterFailure } from "./pure";
import type { ChargeRow, SubRow } from "./store";

/**
 * Failed-payment handling. One state machine for saved-card declines and unpaid pay links:
 * after each unsuccessful attempt the membership either waits for the next retry day
 * (RETRY_DAYS after the period's first attempt) or expires when the schedule is exhausted.
 */

export interface FailureInput {
  dataId: string;
  sub: SubRow;
  charge: ChargeRow;
  reason: string;
  savedMethod: boolean;
  now: Date;
  currency: string;
}
export type FailureOutcome = { outcome: "retry"; at: Date; status: string } | { outcome: "expired" };

export async function recordFailure(i: FailureInput): Promise<FailureOutcome> {
  const failed = Number(i.sub.failed_attempts) + 1;
  const step = dunningStep(failed, new Date(i.charge.period_start));
  if (step.action === "expire") {
    await expireSubscription(i.dataId, i.sub, i.charge, "payment_failed_final");
    return { outcome: "expired" };
  }
  const status = statusAfterFailure(i.sub.status as never, failed, i.savedMethod);
  // A retry can never be scheduled in the past (a late cron tick would otherwise re-run it immediately and forever).
  const at = step.at.getTime() > i.now.getTime() ? step.at : new Date(i.now.getTime() + 3_600_000);
  await query(
    `UPDATE customer_subscriptions SET status = $3, failed_attempts = $4, last_failure_at = $5, next_charge_at = $6, updated_at = NOW() WHERE id = $1 AND user_id = $2`,
    [i.sub.id, i.dataId, status, failed, i.now.toISOString(), at.toISOString()]
  );
  await query(`UPDATE subscription_charges SET attempt = $2, error = $3, status = 'pending' WHERE id = $1`, [i.charge.id, failed, i.reason.slice(0, 500)]);

  const payUrl = await payUrlFor(i.dataId, i.charge.invoice_id);
  const amount = formatMoney(Number(i.charge.amount_minor), i.currency);
  // The first unpaid pay link is just the invoice; tell the member only once it is actually overdue.
  if (i.savedMethod || failed >= 2) {
    const who = await contactEmail(i.dataId, i.sub.contact_id);
    await emitEvent(i.dataId, {
      type: "membership.payment_failed",
      entity: "subscription",
      entityId: i.sub.id,
      data: { contact_id: i.sub.contact_id, to: who.email, name: who.name, reason: i.reason, attempt: failed, next_retry_at: at.toISOString(), amount_minor: Number(i.charge.amount_minor), currency: i.currency, invoice_id: i.charge.invoice_id, pay_url: payUrl },
    });
    await notifyMember(i.dataId, i.sub.contact_id, {
      kind: "membership_payment_failed",
      subscriptionId: i.sub.id,
      subject: "Your membership payment did not go through",
      body:
        `We could not collect ${amount} for your membership${i.savedMethod ? " from the card on file" : ""}. We will try again on ${at.toDateString()}.\n\n` +
        (payUrl ? `Pay now or update how you pay: ${payUrl}\n\n` : "") +
        `If this is not resolved your membership will end.`,
      extra: { pay_url: payUrl },
    });
  }
  return { outcome: "retry", at, status };
}

/** Final failure: membership ends, the open invoice is voided so it stops chasing the customer. */
export async function expireSubscription(dataId: string, sub: SubRow, charge: ChargeRow | null, reason: string): Promise<void> {
  const flipped = await query<{ id: string }>(
    `UPDATE customer_subscriptions SET status = 'expired', cancelled_at = NOW(), next_charge_at = NULL, updated_at = NOW()
      WHERE id = $1 AND user_id = $2 AND status NOT IN ('expired', 'cancelled') RETURNING id`,
    [sub.id, dataId]
  );
  if (flipped.length === 0) return;
  if (charge) {
    await query(`UPDATE subscription_charges SET status = 'failed', error = COALESCE(error, $2) WHERE id = $1 AND status = 'pending'`, [charge.id, reason]);
    if (charge.invoice_id) await voidInvoice(dataId, charge.invoice_id).catch((err: unknown) => logger.warn("void on expiry failed", { err: err instanceof Error ? err.message : String(err) }));
  }
  await emitEvent(dataId, { type: "membership.cancelled", entity: "subscription", entityId: sub.id, data: { contact_id: sub.contact_id, reason, by: "system" } });
  await notifyMember(dataId, sub.contact_id, {
    kind: "membership_expired",
    subscriptionId: sub.id,
    subject: "Your membership has ended",
    body: "Your membership has ended because we could not collect payment. You are welcome to join again at any time.",
  });
}
