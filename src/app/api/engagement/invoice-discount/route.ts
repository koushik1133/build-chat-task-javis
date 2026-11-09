import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { recordAudit } from "@/lib/audit";
import { body, engScope, fail, isResponse, writeLimit } from "@/lib/engagement/http";
import { applyGiftCardToInvoice, applyDiscounts, commitDiscounts, rollbackDiscounts } from "@/lib/engagement/discounts";
import { findUsableCard, giftCardAttemptAllowed } from "@/lib/engagement/giftcards";
import { getInvoice, updateInvoice } from "@/lib/money/invoices";
import { clientIp } from "@/lib/request-limits";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z
  .object({
    invoice_id: z.string().min(1).max(100),
    voucher_code: z.string().trim().min(1).max(40).optional(),
    points: z.number().int().min(1).max(10_000_000).optional(),
    gift_card: z.string().trim().min(1).max(40).optional(),
  })
  .strict()
  .refine((v) => v.voucher_code || v.points || v.gift_card, { message: "Provide a voucher code, points or a gift card" });

const isDiscountLine = (d: string) => /^Discount \(|^Loyalty points \(/.test(d);

/**
 * POST { invoice_id, voucher_code? | points? | gift_card? } (staff, billing).
 * Vouchers and points become negative lines on a DRAFT invoice (before tax); a
 * gift card is a payment against an issued invoice.
 */
export async function POST(req: NextRequest) {
  const scope = await engScope("billing", true);
  if (isResponse(scope)) return scope;
  const limited = await writeLimit(scope, "invoice-discount", 30);
  if (limited) return limited;
  const b = await body(req, Body);
  if (!b.ok) return b.res;
  try {
    const inv = await getInvoice(scope.dataId, b.data.invoice_id);
    if (!inv) return NextResponse.json({ error: "not_found" }, { status: 404 });
    let applied = 0;
    if (b.data.voucher_code || b.data.points) {
      if (inv.status !== "draft") return NextResponse.json({ error: "invalid_request", detail: "Discounts can only be added to a draft invoice." }, { status: 400 });
      if (inv.items.some((i) => isDiscountLine(i.description))) return NextResponse.json({ error: "invalid_request", detail: "A discount has already been applied to this invoice." }, { status: 409 });
      if (b.data.points && !inv.contact_id) return NextResponse.json({ error: "invalid_request", detail: "Points need an invoice contact." }, { status: 400 });
      const r = await applyDiscounts(scope.dataId, { currency: inv.currency, items: inv.items, contactId: inv.contact_id, voucherCodes: b.data.voucher_code ? [b.data.voucher_code] : [], loyaltyPoints: b.data.points });
      if (r.problems.length > 0) return NextResponse.json({ error: "discount_invalid", detail: r.problems[0].message, problems: r.problems }, { status: 400 });
      if (r.lines.length === 0) return NextResponse.json({ error: "invalid_request", detail: "Nothing to discount." }, { status: 400 });
      const entity = { kind: "invoice", id: inv.id };
      await commitDiscounts(scope.dataId, r, entity, inv.contact_id);
      try {
        await updateInvoice(scope.dataId, inv.id, { items: [...inv.items, ...r.lines] });
      } catch (err) {
        await rollbackDiscounts(scope.dataId, entity, inv.contact_id, r.points?.points ?? 0);
        throw err;
      }
      applied = r.discountMinor;
      await recordAudit(scope, { action: "invoice.discount", entity: "invoice", entityId: inv.id, after: { voucher: b.data.voucher_code ?? null, points: b.data.points ?? null, discount_minor: applied } });
    }
    if (b.data.gift_card) {
      if (!(await giftCardAttemptAllowed(clientIp(req), b.data.gift_card))) return NextResponse.json({ error: "rate_limited" }, { status: 429 });
      const card = await findUsableCard(scope.dataId, b.data.gift_card);
      if (!card) return NextResponse.json({ error: "invalid_request", detail: "That gift card could not be used." }, { status: 400 });
      const res = await applyGiftCardToInvoice(scope.dataId, inv.id, card);
      applied += res.applied;
      await recordAudit(scope, { action: "invoice.gift_card", entity: "invoice", entityId: inv.id, after: { last4: card.code_last4, applied_minor: res.applied } });
    }
    return NextResponse.json({ invoice: await getInvoice(scope.dataId, inv.id), applied_minor: applied });
  } catch (err) {
    return fail(err, "engagement.invoice-discount.POST");
  }
}
