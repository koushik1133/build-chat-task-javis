import { createHash, randomBytes, randomUUID } from "crypto";
import { query, queryOne } from "@/lib/dsql";
import { emitEvent } from "@/lib/events/bus";
import { enqueueNotification } from "@/lib/notifications/outbox";
import { rateLimitAsync } from "@/lib/request-limits";
import { formatMoney } from "@/lib/money/items";
import { GIFT_CFG, InsufficientBalanceError, postDelta, type PostResult } from "./ledger";
import { formatGiftCode, isWellFormedGiftCode, normalizeGiftCode } from "./pure";

/**
 * Gift cards. The code (XXXX-XXXX-XXXX-XXXX, 16 chars from an unambiguous
 * 32-letter alphabet = 80 bits) is returned ONCE at issue; only its sha256 and
 * last four characters are stored. Redemption uses the shared optimistic ledger
 * and a per-order ref, so a replayed checkout debits the card once.
 */

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function generateGiftCode(): string {
  const bytes = randomBytes(16);
  let out = "";
  for (let i = 0; i < 16; i++) out += ALPHABET[bytes[i] % 32];
  return formatGiftCode(out);
}

export function hashGiftCode(dataId: string, code: string): string {
  return createHash("sha256").update(`giftcard:${dataId}:${normalizeGiftCode(code)}`).digest("hex");
}

export type GiftCardStatus = "active" | "redeemed" | "void" | "expired";
export interface GiftCardDTO {
  id: string;
  code_last4: string;
  initial_minor: number;
  balance_minor: number;
  currency: string;
  status: GiftCardStatus;
  purchaser_contact_id: string | null;
  recipient_email: string | null;
  message: string | null;
  expires_at: string | null;
  issued_via: "manual" | "storefront";
  order_id: string | null;
  created_at: string;
}
interface Row { id: string; code_last4: string; initial_minor: string | number; balance_minor: string | number; currency: string; status: GiftCardStatus; purchaser_contact_id: string | null; recipient_email: string | null; message: string | null; expires_at: string | Date | null; issued_via: "manual" | "storefront"; order_id: string | null; created_at: string | Date }
const COLS = "id, code_last4, initial_minor, balance_minor, currency, status, purchaser_contact_id, recipient_email, message, expires_at, issued_via, order_id, created_at";
const iso = (v: string | Date | null) => (v ? new Date(v).toISOString() : null);
export const toGiftCardDTO = (r: Row): GiftCardDTO => ({ ...r, initial_minor: Number(r.initial_minor), balance_minor: Number(r.balance_minor), expires_at: iso(r.expires_at), created_at: iso(r.created_at) ?? "" });

export interface IssueInput {
  amountMinor: number;
  currency: string;
  purchaserContactId?: string | null;
  recipientEmail?: string | null;
  message?: string | null;
  expiresAt?: string | null;
  issuedVia: "manual" | "storefront";
  orderId?: string | null;
  /** Idempotency for storefront issuance: one card per (order, line index). */
  refId?: string | null;
  sendEmail?: boolean;
}

/** Issue a card. Returns the code ONCE; a replayed storefront ref returns the existing card without a code. */
export async function issueGiftCard(dataId: string, input: IssueInput): Promise<{ card: GiftCardDTO; code: string | null }> {
  if (!Number.isInteger(input.amountMinor) || input.amountMinor <= 0 || input.amountMinor > 100_000_000) throw new Error("Amount must be a positive whole number of minor units");
  const refId = input.refId ?? null;
  if (refId) {
    const dup = await queryOne<{ gift_card_id: string }>(`SELECT gift_card_id FROM gift_card_ledger WHERE user_id = $1 AND kind = 'issue' AND ref_kind = 'issue' AND ref_id = $2`, [dataId, refId]);
    if (dup) {
      const row = await queryOne<Row>(`SELECT ${COLS} FROM gift_cards WHERE id = $1 AND user_id = $2`, [dup.gift_card_id, dataId]);
      if (row) return { card: toGiftCardDTO(row), code: null };
    }
  }
  const id = randomUUID();
  let code = generateGiftCode();
  for (let attempt = 0; ; attempt++) {
    try {
      await query(
        `INSERT INTO gift_cards (id, user_id, code_hash, code_last4, initial_minor, balance_minor, currency, status, purchaser_contact_id, recipient_email, message, expires_at, issued_via, order_id)
         VALUES ($1,$2,$3,$4,0,0,$5,'active',$6,$7,$8,$9,$10,$11)`,
        [id, dataId, hashGiftCode(dataId, code), code.slice(-4), input.currency.toUpperCase(), input.purchaserContactId ?? null, input.recipientEmail?.trim().toLowerCase() || null, input.message?.slice(0, 500) ?? null, input.expiresAt ?? null, input.issuedVia, input.orderId ?? null]
      );
      break;
    } catch (err) {
      const c = err && typeof err === "object" && "code" in err ? String((err as { code: unknown }).code) : "";
      if (c !== "23505" || attempt > 3) throw err;
      code = generateGiftCode();
    }
  }
  await postDelta(GIFT_CFG, dataId, id, input.amountMinor, { kind: "issue", refKind: "issue", refId: refId ?? id });
  await query(`UPDATE gift_cards SET initial_minor = $3 WHERE id = $1 AND user_id = $2`, [id, dataId, input.amountMinor]);
  const row = await queryOne<Row>(`SELECT ${COLS} FROM gift_cards WHERE id = $1 AND user_id = $2`, [id, dataId]);
  if (!row) throw new Error("Gift card vanished after insert");
  const card = toGiftCardDTO(row);
  void emitEvent(dataId, { type: "gift_card.issued", entity: "gift_card", entityId: id, data: { amount_minor: input.amountMinor, currency: card.currency, issued_via: input.issuedVia } });
  if (input.sendEmail !== false && card.recipient_email) {
    await enqueueNotification(dataId, {
      channel: "email",
      recipient: card.recipient_email,
      subject: `Your gift card (${formatMoney(card.initial_minor, card.currency)})`,
      body: `You have received a gift card worth ${formatMoney(card.initial_minor, card.currency)}.\n\n${card.message ? `"${card.message}"\n\n` : ""}Your code: ${code}\n\nEnter it at checkout to use your balance. Keep this email safe: the code cannot be shown again.`,
      data: { kind: "gift_card", category: "orders", gift_card_id: id },
    }).catch((e) => console.error("[giftcards] email failed:", e));
  }
  return { card, code };
}

export async function getGiftCard(dataId: string, id: string): Promise<GiftCardDTO | null> {
  const r = await queryOne<Row>(`SELECT ${COLS} FROM gift_cards WHERE id = $1 AND user_id = $2`, [id, dataId]);
  return r ? toGiftCardDTO(r) : null;
}
export async function listGiftCards(dataId: string, opts: { status?: string | null; limit?: number } = {}): Promise<GiftCardDTO[]> {
  const params: unknown[] = [dataId];
  let where = "user_id = $1";
  if (opts.status) { params.push(opts.status); where += ` AND status = $${params.length}`; }
  params.push(Math.min(Math.max(opts.limit ?? 50, 1), 200));
  const rows = await query<Row>(`SELECT ${COLS} FROM gift_cards WHERE ${where} ORDER BY created_at DESC, id DESC LIMIT $${params.length}`, params);
  return rows.map(toGiftCardDTO);
}
export async function giftCardLedger(dataId: string, id: string): Promise<Array<{ id: string; kind: string; amount_minor: number; balance_after: number; ref_kind: string | null; ref_id: string | null; created_at: string }>> {
  const rows = await query<{ id: string; kind: string; amount_minor: string | number; balance_after: string | number; ref_kind: string | null; ref_id: string | null; created_at: string | Date }>(`SELECT id, kind, amount_minor, balance_after, ref_kind, ref_id, created_at FROM gift_card_ledger WHERE user_id = $1 AND gift_card_id = $2 ORDER BY created_at ASC, id ASC`, [dataId, id]);
  return rows.map((r) => ({ ...r, amount_minor: Number(r.amount_minor), balance_after: Number(r.balance_after), created_at: new Date(r.created_at).toISOString() }));
}

/** Resolve a card by code; null for unknown, malformed, void, expired or empty cards (callers show one generic error). */
export async function findUsableCard(dataId: string, code: string, now: Date = new Date()): Promise<GiftCardDTO | null> {
  if (!isWellFormedGiftCode(code)) return null;
  const r = await queryOne<Row>(`SELECT ${COLS} FROM gift_cards WHERE user_id = $1 AND code_hash = $2`, [dataId, hashGiftCode(dataId, code)]);
  if (!r) return null;
  const card = toGiftCardDTO(r);
  if (card.status !== "active" || card.balance_minor <= 0) return null;
  if (card.expires_at && new Date(card.expires_at).getTime() < now.getTime()) return null;
  return card;
}

/**
 * Anti brute-force for the public balance/validate/checkout paths. Buckets are
 * independent of the code text (rotating prefixes buys nothing): 10/min and 60/day
 * per IP, plus a global ceiling of 600/min across all callers. Returns false when blocked.
 */
export async function giftCardAttemptAllowed(ip: string): Promise<boolean> {
  // Per-IP buckets first; the global bucket is only consumed by attempts that passed them,
  // so a single blocked client cannot exhaust the platform-wide ceiling.
  const [m, d] = await Promise.all([rateLimitAsync(`gcard:m:${ip}`, 10, 60_000), rateLimitAsync(`gcard:d:${ip}`, 60, 86_400_000)]);
  if (!m.allowed || !d.allowed) return false;
  return (await rateLimitAsync(`gcard:g`, 600, 60_000)).allowed;
}

/** Debit up to `amountMinor` from the card for an entity. Idempotent per (entity). Returns the amount actually applied. */
export async function redeemGiftCard(dataId: string, cardId: string, amountMinor: number, ref: { refKind: string; refId: string }): Promise<PostResult & { applied: number }> {
  const card = await getGiftCard(dataId, cardId);
  if (!card || card.status !== "active") throw new Error("Gift card is not usable");
  if (card.expires_at && new Date(card.expires_at).getTime() < Date.now()) throw new Error("Gift card has expired");
  const apply = Math.min(Math.trunc(amountMinor), card.balance_minor);
  if (apply <= 0) throw new Error("Nothing to redeem");
  try {
    const res = await postDelta(GIFT_CFG, dataId, cardId, -apply, { kind: "redeem", refKind: ref.refKind, refId: ref.refId });
    const applied = res.duplicate ? Math.abs(Number((await queryOne<{ amount_minor: string | number }>(`SELECT amount_minor FROM gift_card_ledger WHERE id = $1`, [res.id]))?.amount_minor ?? 0)) : apply;
    if (res.balanceAfter === 0) await query(`UPDATE gift_cards SET status = 'redeemed', updated_at = NOW() WHERE id = $1 AND user_id = $2 AND status = 'active' AND balance_minor = 0`, [cardId, dataId]);
    return { ...res, applied };
  } catch (err) {
    if (err instanceof InsufficientBalanceError) throw new Error("Gift card balance changed; try again");
    throw err;
  }
}

/** Put money back on a card (order cancelled / refunded to the card). Reactivates a fully-used card. */
export async function refundToGiftCard(dataId: string, cardId: string, amountMinor: number, ref: { refKind: string; refId: string }): Promise<PostResult> {
  const res = await postDelta(GIFT_CFG, dataId, cardId, Math.trunc(amountMinor), { kind: "refund", refKind: ref.refKind, refId: ref.refId });
  await query(`UPDATE gift_cards SET status = 'active', updated_at = NOW() WHERE id = $1 AND user_id = $2 AND status = 'redeemed' AND balance_minor > 0`, [cardId, dataId]);
  return res;
}

export async function adjustGiftCard(dataId: string, id: string, deltaMinor: number): Promise<PostResult> {
  const card = await getGiftCard(dataId, id);
  if (!card) throw new Error("Gift card not found");
  if (card.status === "void") throw new Error("Gift card is void");
  if (!Number.isInteger(deltaMinor) || deltaMinor === 0) throw new Error("Adjustment must be a non-zero whole number");
  const res = await postDelta(GIFT_CFG, dataId, id, deltaMinor, { kind: "adjust", refKind: "manual", refId: randomUUID() });
  await query(`UPDATE gift_cards SET status = CASE WHEN balance_minor > 0 THEN 'active' ELSE 'redeemed' END, updated_at = NOW() WHERE id = $1 AND user_id = $2 AND status IN ('active','redeemed')`, [id, dataId]);
  return res;
}

export async function voidGiftCard(dataId: string, id: string): Promise<GiftCardDTO> {
  await query(`UPDATE gift_cards SET status = 'void', updated_at = NOW() WHERE id = $1 AND user_id = $2 AND status <> 'void'`, [id, dataId]);
  const c = await getGiftCard(dataId, id);
  if (!c) throw new Error("Gift card not found");
  return c;
}

/** Cron: mark cards past expires_at as expired. */
export async function expireGiftCards(limit = 100): Promise<number> {
  const rows = await query<{ id: string }>(`UPDATE gift_cards SET status = 'expired', updated_at = NOW() WHERE id IN (SELECT id FROM gift_cards WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at < NOW() LIMIT $1) RETURNING id`, [limit]);
  return rows.length;
}

/**
 * Return value to a customer after a refund: back onto the gift card they paid
 * with when there was one, else issue store credit as a fresh gift card.
 * Used by order cancellation and (later) returns.
 */
export async function creditGiftCardOrIssueStoreCredit(dataId: string, input: { orderId: string; amountMinor: number; currency: string; contactId?: string | null; email?: string | null; preferCardId?: string | null }): Promise<{ cardId: string; code: string | null }> {
  if (input.preferCardId) {
    await refundToGiftCard(dataId, input.preferCardId, input.amountMinor, { refKind: "order_refund", refId: input.orderId });
    return { cardId: input.preferCardId, code: null };
  }
  const { card, code } = await issueGiftCard(dataId, { amountMinor: input.amountMinor, currency: input.currency, purchaserContactId: input.contactId ?? null, recipientEmail: input.email ?? null, message: "Store credit", issuedVia: "manual", orderId: input.orderId, refId: `credit:${input.orderId}` });
  return { cardId: card.id, code };
}

/** Called from credit-notes refundPayment for payments made with provider `gift_card`. */
export async function refundGiftCardPayment(dataId: string, providerRef: string, amountMinor: number, invoiceId: string): Promise<string> {
  const led = await queryOne<{ gift_card_id: string }>(`SELECT gift_card_id FROM gift_card_ledger WHERE id = $1 AND user_id = $2`, [providerRef, dataId]);
  if (!led) throw new Error("Gift card payment not found");
  const res = await refundToGiftCard(dataId, led.gift_card_id, amountMinor, { refKind: "invoice_refund", refId: `${invoiceId}:${providerRef}:${amountMinor}:${Date.now()}` });
  return res.id;
}
