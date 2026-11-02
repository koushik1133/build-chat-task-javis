import { query, queryOne } from "@/lib/dsql";
import type { PaymentEvent } from "@/lib/payments/types";
import { PURCHASE_REF_PREFIX, type PurchaseRow } from "./checkout";
import { postLedger } from "./ledger";

/**
 * Apply a verified provider payment event to a credit purchase.
 *
 * Returns null when the event does not belong to a credit purchase (so the
 * caller can fall through to its other handlers). Marking the purchase paid is
 * a conditional UPDATE (`status = 'pending'`), and the ledger post is keyed on
 * the purchase id, so replays and parallel deliveries credit exactly once.
 *
 * Hook: call this from `processWebhook` in src/lib/payments/webhook.ts when
 * `applyPaymentEvent` returns null (the event mapped to no invoice).
 */
export interface CreditPaymentResult {
  purchaseId: string;
  status: "paid" | "failed" | "ignored";
  credited: boolean;
  balanceAfter?: number;
  reason?: string;
}

async function findPurchase(providerId: string, evt: PaymentEvent): Promise<PurchaseRow | null> {
  if (evt.invoiceId && evt.invoiceId.startsWith(PURCHASE_REF_PREFIX)) {
    const id = evt.invoiceId.slice(PURCHASE_REF_PREFIX.length);
    const row = await queryOne<PurchaseRow>(`SELECT * FROM ai_credit_purchases WHERE id = $1`, [id]);
    if (row) return row;
  }
  if (evt.providerRef) {
    return queryOne<PurchaseRow>(
      `SELECT * FROM ai_credit_purchases WHERE provider = $1 AND provider_ref = $2 ORDER BY created_at DESC LIMIT 1`,
      [providerId, evt.providerRef]
    );
  }
  return null;
}

export async function handleCreditPaymentEvent(providerId: string, evt: PaymentEvent): Promise<CreditPaymentResult | null> {
  const purchase = await findPurchase(providerId, evt).catch(() => null);
  if (!purchase) return null;

  if (evt.type === "payment.failed") {
    await query(`UPDATE ai_credit_purchases SET status = 'failed' WHERE id = $1 AND status = 'pending'`, [purchase.id]);
    return { purchaseId: purchase.id, status: "failed", credited: false };
  }

  const expectedMinor = Number(purchase.amount_minor);
  if (evt.amountMinor < expectedMinor) {
    return { purchaseId: purchase.id, status: "ignored", credited: false, reason: `amount ${evt.amountMinor} < ${expectedMinor}` };
  }
  if (evt.currency && evt.currency.toUpperCase() !== purchase.currency.toUpperCase()) {
    return { purchaseId: purchase.id, status: "ignored", credited: false, reason: `currency ${evt.currency} ≠ ${purchase.currency}` };
  }

  const flipped = await queryOne<{ id: string }>(
    `UPDATE ai_credit_purchases SET status = 'paid', paid_at = NOW(), provider_ref = COALESCE(provider_ref, $2)
      WHERE id = $1 AND status = 'pending' RETURNING id`,
    [purchase.id, evt.providerRef || null]
  );
  if (!flipped && purchase.status !== "paid") {
    return { purchaseId: purchase.id, status: "ignored", credited: false, reason: `purchase is ${purchase.status}` };
  }

  // Even on a replay (already paid) the ledger post is idempotent, so a crash
  // between the two statements self-heals on the provider's retry.
  const posted = await postLedger(purchase.user_id, {
    kind: "purchase",
    credits: Number(purchase.credits),
    refKind: "purchase",
    refId: purchase.id,
    note: `${purchase.pack_id} pack via ${providerId}`,
  });
  return { purchaseId: purchase.id, status: "paid", credited: !posted.duplicate, balanceAfter: posted.balanceAfter };
}
