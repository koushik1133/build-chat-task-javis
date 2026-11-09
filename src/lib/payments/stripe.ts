import { createHmac, timingSafeEqual } from "crypto";
import type { PaymentProvider, VerifyWebhookResult } from "./types";

/**
 * Stripe via plain REST (no SDK). Checkout Sessions for pay links; webhook
 * verification implements the `Stripe-Signature` scheme:
 *   t=<unix>,v1=<hex hmac-sha256(secret, `${t}.${rawBody}`)>
 */

const API = "https://api.stripe.com/v1";
export const STRIPE_TOLERANCE_SEC = 300;

function form(data: Record<string, string>): string {
  return new URLSearchParams(data).toString();
}

export function verifyStripeSignature(
  rawBody: string,
  sigHeader: string | null,
  secret: string,
  nowSec = Math.floor(Date.now() / 1000),
  toleranceSec = STRIPE_TOLERANCE_SEC
): { ok: boolean; error?: string } {
  if (!sigHeader) return { ok: false, error: "missing signature" };
  let t = "";
  const v1: string[] = [];
  for (const part of sigHeader.split(",")) {
    const [k, v] = part.trim().split("=", 2);
    if (k === "t") t = v ?? "";
    else if (k === "v1" && v) v1.push(v);
  }
  const ts = Number(t);
  if (!Number.isFinite(ts) || v1.length === 0) return { ok: false, error: "malformed signature" };
  if (Math.abs(nowSec - ts) > toleranceSec) return { ok: false, error: "timestamp outside tolerance" };
  const expected = createHmac("sha256", secret).update(`${t}.${rawBody}`, "utf8").digest("hex");
  const eb = Buffer.from(expected, "utf8");
  for (const sig of v1) {
    const sb = Buffer.from(sig, "utf8");
    if (sb.length === eb.length && timingSafeEqual(sb, eb)) return { ok: true };
  }
  return { ok: false, error: "signature mismatch" };
}

export function parseStripeEvent(rawBody: string): VerifyWebhookResult {
  let evt: unknown;
  try {
    evt = JSON.parse(rawBody);
  } catch {
    return { ok: false, error: "invalid json" };
  }
  if (!evt || typeof evt !== "object") return { ok: false, error: "invalid payload" };
  const e = evt as { id?: unknown; type?: unknown; data?: { object?: Record<string, unknown> } };
  const obj = e.data?.object ?? {};
  const meta = (obj.metadata ?? {}) as Record<string, unknown>;
  const invoiceId = typeof meta.invoice_id === "string" ? meta.invoice_id : null;
  const base = {
    eventId: String(e.id ?? ""),
    providerRef: String(obj.id ?? ""),
    invoiceId,
    currency: String(obj.currency ?? "").toUpperCase(),
    raw: evt,
  };
  if (e.type === "checkout.session.completed" && obj.payment_status === "paid") {
    return { ok: true, event: { ...base, type: "payment.succeeded", amountMinor: Number(obj.amount_total ?? 0) } };
  }
  if (e.type === "checkout.session.async_payment_succeeded") {
    return { ok: true, event: { ...base, type: "payment.succeeded", amountMinor: Number(obj.amount_total ?? 0) } };
  }
  if (e.type === "checkout.session.async_payment_failed" || e.type === "checkout.session.expired") {
    return { ok: true, event: { ...base, type: "payment.failed", amountMinor: Number(obj.amount_total ?? 0) } };
  }
  return { ok: true };
}

export const stripeProvider: PaymentProvider = {
  id: "stripe",
  configured: () => Boolean(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_WEBHOOK_SECRET),
  async createCheckout(input) {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) throw new Error("STRIPE_SECRET_KEY is not set");
    const body = form({
      mode: "payment",
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
      client_reference_id: input.invoiceId,
      "metadata[invoice_id]": input.invoiceId,
      "metadata[pay_token]": input.token,
      "line_items[0][quantity]": "1",
      "line_items[0][price_data][currency]": input.currency.toLowerCase(),
      "line_items[0][price_data][unit_amount]": String(input.amountMinor),
      "line_items[0][price_data][product_data][name]": input.description.slice(0, 250),
    });
    const res = await fetch(`${API}/checkout/sessions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    const json = (await res.json()) as { id?: string; url?: string; error?: { message?: string } };
    if (!res.ok || !json.url || !json.id) throw new Error(json.error?.message ?? `Stripe error ${res.status}`);
    return { url: json.url, providerRef: json.id };
  },
  async verifyWebhook(rawBody, headers) {
    const secret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!secret) return { ok: false, error: "STRIPE_WEBHOOK_SECRET not set" };
    const v = verifyStripeSignature(rawBody, headers.get("stripe-signature"), secret);
    if (!v.ok) return v;
    return parseStripeEvent(rawBody);
  },
  async refund() {
    // Stub: Checkout Sessions must be refunded through the underlying PaymentIntent (POST /v1/refunds).
    throw new Error("Stripe refunds are not wired yet; refund from the Stripe dashboard and record it manually");
  },
};
