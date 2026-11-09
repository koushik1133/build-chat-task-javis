import { randomBytes, randomUUID } from "crypto";
import { query, queryOne } from "@/lib/dsql";
import { getProvider } from "@/lib/payments";
import { appOrigin, hashToken } from "@/lib/share-tokens";
import { getPack, type CreditPack } from "./packs";

/**
 * Credit-pack checkout. A purchase row is created `pending` with a public
 * token; the token opens /p/credits/<token> (the simulated checkout page, or
 * the return page for a real provider). The purchase flips to `paid` and the
 * ledger is credited only through `handleCreditPaymentEvent` (./webhook.ts).
 */

export type PurchaseStatus = "pending" | "paid" | "failed";

export interface PurchaseRow {
  id: string;
  user_id: string;
  pack_id: string;
  credits: string | number;
  amount_minor: string | number;
  currency: string;
  provider: string;
  provider_ref: string | null;
  status: PurchaseStatus;
  token_hash: string | null;
  created_at: string;
  paid_at: string | null;
}

export interface PurchaseDTO {
  id: string;
  pack_id: string;
  pack_name: string;
  credits: number;
  amount_minor: number;
  currency: string;
  provider: string;
  status: PurchaseStatus;
  created_at: string;
  paid_at: string | null;
}

export function toPurchaseDTO(r: PurchaseRow): PurchaseDTO {
  return {
    id: r.id,
    pack_id: r.pack_id,
    pack_name: getPack(r.pack_id)?.name ?? r.pack_id,
    credits: Number(r.credits),
    amount_minor: Number(r.amount_minor),
    currency: r.currency,
    provider: r.provider,
    status: r.status,
    created_at: r.created_at,
    paid_at: r.paid_at,
  };
}

/** Metadata reference handed to the provider; lets webhooks map back without a provider_ref lookup. */
export const PURCHASE_REF_PREFIX = "credits:";

export function creditsPath(token: string): string {
  return `/p/credits/${token}`;
}

export async function startCheckout(
  userId: string,
  packId: string
): Promise<{ url: string; purchaseId: string; provider: string; token: string; pack: CreditPack }> {
  const pack = getPack(packId);
  if (!pack) throw new Error("Unknown credit pack");

  const provider = getProvider();
  const purchaseId = randomUUID();
  const token = randomBytes(24).toString("base64url");
  const origin = appOrigin();
  const returnUrl = `${origin}${creditsPath(token)}`;

  const checkout = await provider.createCheckout({
    invoiceId: `${PURCHASE_REF_PREFIX}${purchaseId}`,
    amountMinor: pack.price_minor,
    currency: pack.currency,
    description: `${pack.name} AI credit pack (${pack.credits.toLocaleString()} credits)`,
    successUrl: `${returnUrl}?outcome=success`,
    cancelUrl: `${returnUrl}?outcome=cancel`,
    token,
  });

  await query(
    `INSERT INTO ai_credit_purchases (id, user_id, pack_id, credits, amount_minor, currency, provider, provider_ref, status, token_hash)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', $9)`,
    [purchaseId, userId, pack.id, pack.credits, pack.price_minor, pack.currency, provider.id, checkout.providerRef, hashToken(token)]
  );

  // The simulated provider's checkout is the invoice pay page; credits have their own.
  const url =
    provider.id === "simulated" ? returnUrl : checkout.url.startsWith("/") ? `${origin}${checkout.url}` : checkout.url;
  return { url, purchaseId, provider: provider.id, token, pack };
}

/** A pending checkout link stops working after this long; paid/failed ones stay viewable. */
export const CHECKOUT_LINK_TTL_MS = 7 * 86_400_000;

export function isPurchaseExpired(p: Pick<PurchaseRow, "status" | "created_at">, now = Date.now()): boolean {
  if (p.status !== "pending") return false;
  const created = new Date(p.created_at).getTime();
  return Number.isFinite(created) && now - created > CHECKOUT_LINK_TTL_MS;
}

export async function getPurchaseByToken(token: string): Promise<PurchaseRow | null> {
  if (!token || token.length > 128 || !/^[A-Za-z0-9_-]+$/.test(token)) return null;
  return queryOne<PurchaseRow>(`SELECT * FROM ai_credit_purchases WHERE token_hash = $1`, [hashToken(token)]);
}

export async function getPurchase(userId: string, id: string): Promise<PurchaseRow | null> {
  return queryOne<PurchaseRow>(`SELECT * FROM ai_credit_purchases WHERE id = $1 AND user_id = $2`, [id, userId]);
}

export async function listPurchases(userId: string, limit = 20): Promise<PurchaseDTO[]> {
  const rows = await query<PurchaseRow>(
    `SELECT * FROM ai_credit_purchases WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [userId, Math.min(Math.max(limit, 1), 100)]
  );
  return rows.map(toPurchaseDTO);
}
