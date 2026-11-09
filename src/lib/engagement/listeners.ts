import { query } from "@/lib/dsql";
import { getInvoiceById } from "@/lib/money/invoices";
import { tableExists } from "@/lib/table-exists";
import { issueGiftCard } from "./giftcards";
import { earnPoints } from "./loyalty";
import { qualifyReferral } from "./referrals";

/**
 * Invoked (dynamic import, inside try/catch) from recomputeInvoiceStatus when an
 * invoice becomes paid. Everything here is idempotent per invoice: loyalty
 * earn, referral qualification and gift-card issuance all key off the invoice id.
 */
export async function onPaidForEngagement(dataId: string, invoiceId: string): Promise<void> {
  if (!(await tableExists("loyalty_accounts"))) return;
  const inv = await getInvoiceById(invoiceId);
  if (!inv || inv.status === "void") return;

  // Gift-card product lines (storefront): issue one card per unit, and exclude them from earn/referral amounts.
  let giftCardMinor = 0;
  const ids = [...new Set(inv.items.map((i) => i.product_id).filter((x): x is string => Boolean(x)))];
  if (ids.length > 0) {
    const flagged = await query<{ id: string }>(`SELECT id FROM products WHERE user_id = $1 AND id = ANY($2) AND is_gift_card = TRUE`, [dataId, ids]).catch(() => []);
    const giftIds = new Set(flagged.map((f) => f.id));
    if (giftIds.size > 0) {
      const order = await query<{ id: string; customer_email: string }>(`SELECT id, customer_email FROM orders WHERE user_id = $1 AND invoice_id = $2`, [dataId, invoiceId]).catch(() => []);
      let line = 0;
      for (const it of inv.items) {
        if (!it.product_id || !giftIds.has(it.product_id)) continue;
        const units = Math.max(1, Math.ceil(it.qty));
        giftCardMinor += it.unit_minor * units;
        for (let u = 0; u < units; u++) {
          await issueGiftCard(dataId, {
            amountMinor: it.unit_minor,
            currency: inv.currency,
            purchaserContactId: inv.contact_id,
            recipientEmail: order[0]?.customer_email ?? inv.contact_email,
            message: null,
            issuedVia: "storefront",
            orderId: order[0]?.id ?? null,
            refId: `inv:${invoiceId}:${line}:${u}`,
          }).catch((e) => console.error("[engagement] gift card issue failed:", e));
        }
        line++;
      }
    }
  }

  if (!inv.contact_id) return;
  const net = Math.max(0, inv.subtotal_minor - giftCardMinor);
  if (net > 0) {
    await earnPoints(dataId, inv.contact_id, { amountMinor: net, refKind: "invoice", refId: invoiceId, note: `Invoice ${inv.number}` }).catch((e) => console.error("[engagement] earn failed:", e));
    await qualifyReferral(dataId, inv.contact_id, net).catch((e) => console.error("[engagement] referral failed:", e));
  }
}
