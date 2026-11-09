import { query } from "@/lib/dsql";
import { getInvoice, recordPayment } from "@/lib/money/invoices";
import type { LineItem } from "@/lib/money/items";
import { tableExists } from "@/lib/table-exists";
import { findUsableCard, redeemGiftCard, refundToGiftCard, type GiftCardDTO } from "./giftcards";
import { redeemPoints, redeemQuote, refundRedeemed } from "./loyalty";
import { checkStacking, discountLines, pointsValueMinor, type DiscountItem } from "./pure";
import { recordRedemption, releaseRedemptions, validateVoucher, type VoucherDTO } from "./vouchers";

/**
 * Discount orchestration shared by storefront checkout and staff documents.
 *
 * Order of operations (all BEFORE tax): vouchers, then loyalty points on the
 * remaining subtotal. Each becomes negative line items carrying the tax
 * treatment of the goods they discount, so the tax engine reduces tax
 * correctly (see `discountLines` in ./pure for the inclusive-pricing note).
 * Gift cards are NOT discounts: they are a payment taken after tax, recorded as
 * an `invoice_payments` row with provider `gift_card`.
 */

export interface ApplyInput {
  currency: string;
  /** Goods lines (no shipping). */
  items: readonly LineItem[];
  contactId?: string | null;
  voucherCodes?: readonly string[];
  loyaltyPoints?: number;
  giftCardCode?: string | null;
  now?: Date;
}

export interface DiscountProblem {
  field: "voucher" | "points" | "gift_card";
  code: string;
  message: string;
}

export interface ApplyResult {
  /** Total taken off before tax (vouchers + points). */
  discountMinor: number;
  lines: LineItem[];
  freeShipping: boolean;
  vouchers: Array<{ voucher: VoucherDTO; discountMinor: number }>;
  points: { points: number; valueMinor: number } | null;
  giftCard: { id: string; last4: string; balance_minor: number } | null;
  problems: DiscountProblem[];
}

const MAX_CODES = 5;

export async function applyDiscounts(dataId: string, input: ApplyInput): Promise<ApplyResult> {
  const out: ApplyResult = { discountMinor: 0, lines: [], freeShipping: false, vouchers: [], points: null, giftCard: null, problems: [] };
  // Gift-card products are never discountable: a voucher or points on a card would mint money below face value.
  const productIds = [...new Set(input.items.map((i) => i.product_id).filter((x): x is string => Boolean(x)))];
  const giftIds = new Set<string>();
  if (productIds.length > 0) {
    const flagged = await query<{ id: string }>(`SELECT id FROM products WHERE user_id = $1 AND id = ANY($2) AND is_gift_card = TRUE`, [dataId, productIds]).catch(() => []);
    for (const f of flagged) giftIds.add(f.id);
  }
  const goods = input.items.filter((i) => i.unit_minor > 0 && !(i.product_id && giftIds.has(i.product_id)));
  const subtotal = goods.reduce((s, i) => s + Math.floor(i.qty * i.unit_minor + 0.5), 0);

  const codes = [...new Set((input.voucherCodes ?? []).map((c) => c.trim().toUpperCase()).filter(Boolean))].slice(0, MAX_CODES);
  if (codes.length > 0 && subtotal > 0) {
    const ids = [...new Set(goods.map((g) => g.product_id).filter((x): x is string => Boolean(x)))];
    const kinds = new Map<string, string>();
    if (ids.length > 0) {
      const rows = await query<{ id: string; kind: string }>(`SELECT id, kind FROM products WHERE user_id = $1 AND id = ANY($2)`, [dataId, ids]).catch(() => []);
      for (const r of rows) kinds.set(r.id, r.kind);
    }
    const items: DiscountItem[] = goods.map((g) => ({ product_id: g.product_id ?? null, kind: g.product_id ? (kinds.get(g.product_id) ?? null) : null, line_minor: Math.floor(g.qty * g.unit_minor + 0.5) }));
    const valid: Array<{ voucher: VoucherDTO; discountMinor: number; free: boolean }> = [];
    for (const code of codes) {
      const r = await validateVoucher(dataId, code, { currency: input.currency, subtotalMinor: subtotal, items, contactId: input.contactId ?? null, now: input.now });
      if (!r.evaluation.ok) out.problems.push({ field: "voucher", code: r.evaluation.reason, message: r.evaluation.message });
      else valid.push({ voucher: r.voucher as VoucherDTO, discountMinor: r.evaluation.discountMinor, free: r.evaluation.freeShipping });
    }
    const stack = checkStacking(valid.map((v) => v.voucher));
    const kept = stack.ok ? valid : valid.filter((v) => v.voucher.id !== stack.offending);
    if (!stack.ok) out.problems.push({ field: "voucher", code: "not_stackable", message: "This code cannot be combined with another discount." });
    let remaining = subtotal;
    for (const v of kept) {
      const d = Math.min(v.discountMinor, remaining);
      remaining -= d;
      out.vouchers.push({ voucher: v.voucher, discountMinor: d });
      if (v.free) out.freeShipping = true;
    }
    const voucherTotal = out.vouchers.reduce((s, v) => s + v.discountMinor, 0);
    if (voucherTotal > 0) out.lines.push(...discountLines(goods, voucherTotal, `Discount (${out.vouchers.filter((v) => v.discountMinor > 0).map((v) => v.voucher.code_upper).join(", ")})`));
    out.discountMinor += voucherTotal;
  }

  const wantPoints = Math.trunc(input.loyaltyPoints ?? 0);
  if (wantPoints > 0) {
    if (!input.contactId) out.problems.push({ field: "points", code: "no_account", message: "Sign in to your rewards account to use points." });
    else {
      const q = await redeemQuote(dataId, input.contactId, subtotal - out.discountMinor);
      if (wantPoints > q.maxPoints) out.problems.push({ field: "points", code: "too_many", message: q.maxPoints === 0 ? `You need at least ${q.program.min_redeem_points} points to redeem.` : `You can use at most ${q.maxPoints} points on this order.` });
      else {
        const value = Math.min(pointsValueMinor(q.program, wantPoints), subtotal - out.discountMinor);
        out.points = { points: wantPoints, valueMinor: value };
        out.lines.push(...discountLines(goods, value, `Loyalty points (${wantPoints})`));
        out.discountMinor += value;
      }
    }
  }

  if (input.giftCardCode?.trim()) {
    const card = await findUsableCard(dataId, input.giftCardCode, input.now);
    if (!card || card.currency.toUpperCase() !== input.currency.toUpperCase()) out.problems.push({ field: "gift_card", code: "invalid", message: "That gift card could not be used." });
    else out.giftCard = { id: card.id, last4: card.code_last4, balance_minor: card.balance_minor };
  }
  return out;
}

export class DiscountApplicationError extends Error {
  constructor(public readonly problems: DiscountProblem[]) {
    super(problems[0]?.message ?? "Discount could not be applied");
    this.name = "DiscountApplicationError";
  }
}

/**
 * Commit an ApplyResult against a created order/invoice: voucher redemptions
 * (idempotent per entity), points debit (idempotent per entity). Gift cards are
 * committed separately with `applyGiftCardToInvoice` once the invoice exists.
 * On any failure everything already committed here is rolled back.
 */
export async function commitDiscounts(dataId: string, result: ApplyResult, entity: { kind: string; id: string }, contactId: string | null): Promise<void> {
  const redeemedPoints: number[] = [];
  try {
    for (const v of result.vouchers) await recordRedemption(dataId, v.voucher, entity, contactId, v.discountMinor);
    if (result.points && contactId) {
      await redeemPoints(dataId, contactId, result.points.points, { refKind: entity.kind, refId: entity.id, note: `Redeemed on ${entity.kind}` });
      redeemedPoints.push(result.points.points);
    }
  } catch (err) {
    await releaseRedemptions(dataId, entity).catch(() => undefined);
    if (contactId && redeemedPoints[0]) await refundRedeemed(dataId, contactId, redeemedPoints[0], { refKind: entity.kind, refId: entity.id }).catch(() => undefined);
    throw err;
  }
}

/** Undo voucher + points effects for a cancelled, unpaid order. */
export async function rollbackDiscounts(dataId: string, entity: { kind: string; id: string }, contactId: string | null, points: number): Promise<void> {
  await releaseRedemptions(dataId, entity).catch(() => undefined);
  if (contactId && points > 0) await refundRedeemed(dataId, contactId, points, { refKind: entity.kind, refId: entity.id }).catch(() => undefined);
}

/** Give back everything an unpaid, cancelled order consumed: voucher uses and redeemed loyalty points. Idempotent. */
export async function releaseOrderDiscounts(dataId: string, orderId: string, contactId: string | null): Promise<void> {
  const redeemed = contactId
    ? await query<{ points: string | number }>(`SELECT points FROM loyalty_ledger WHERE user_id = $1 AND kind = 'redeem' AND ref_kind = 'order' AND ref_id = $2`, [dataId, orderId]).catch(() => [])
    : [];
  const points = redeemed.reduce((sum, r) => sum + Math.abs(Number(r.points)), 0);
  await rollbackDiscounts(dataId, { kind: "order", id: orderId }, contactId, points);
}

/**
 * Pay (part of) an invoice with a gift card: debit the card, then record an
 * `invoice_payments` row (provider `gift_card`, provider_ref = ledger entry id).
 * If recording the payment fails the card is credited back.
 */
export async function applyGiftCardToInvoice(dataId: string, invoiceId: string, card: Pick<GiftCardDTO, "id" | "currency">, maxMinor?: number): Promise<{ applied: number; invoiceStatus: string | null }> {
  const inv = await getInvoice(dataId, invoiceId);
  if (!inv) throw new Error("Invoice not found");
  if (inv.status === "void" || inv.status === "draft") throw new Error("Invoice cannot take payments yet");
  if (inv.currency.toUpperCase() !== card.currency.toUpperCase()) throw new Error("Gift card currency does not match the invoice");
  const outstanding = Math.max(0, inv.total_minor - inv.paid_minor);
  const want = Math.min(outstanding, maxMinor ?? outstanding);
  if (want <= 0) return { applied: 0, invoiceStatus: inv.status };
  const ref = { refKind: "invoice", refId: `${invoiceId}:${card.id}` };
  const res = await redeemGiftCard(dataId, card.id, want, ref);
  try {
    const paid = await recordPayment({ invoiceId, provider: "gift_card", providerRef: res.id, amountMinor: res.applied, currency: inv.currency });
    return { applied: res.applied, invoiceStatus: paid.status };
  } catch (err) {
    await refundToGiftCard(dataId, card.id, res.applied, { refKind: "invoice_rollback", refId: `${invoiceId}:${card.id}` }).catch(() => undefined);
    throw err;
  }
}

export async function discountsAvailable(): Promise<boolean> {
  return tableExists("vouchers");
}
