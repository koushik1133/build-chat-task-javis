import { createHmac, timingSafeEqual } from "crypto";
import type { PaymentProvider, VerifyWebhookResult } from "./types";

/**
 * Razorpay via REST (basic auth key_id:key_secret). We create a Payment Link
 * (hosted page) and verify webhooks with X-Razorpay-Signature =
 * hex hmac-sha256(webhook_secret, rawBody).
 */

const API = "https://api.razorpay.com/v1";

export function verifyRazorpaySignature(rawBody: string, sig: string | null, secret: string): boolean {
  if (!sig) return false;
  const expected = createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
  const a = Buffer.from(sig, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

export function parseRazorpayEvent(rawBody: string, eventId: string): VerifyWebhookResult {
  let evt: unknown;
  try {
    evt = JSON.parse(rawBody);
  } catch {
    return { ok: false, error: "invalid json" };
  }
  if (!evt || typeof evt !== "object") return { ok: false, error: "invalid payload" };
  const e = evt as { event?: unknown; payload?: Record<string, { entity?: Record<string, unknown> }> };
  const pay = e.payload?.payment?.entity ?? {};
  const link = e.payload?.payment_link?.entity ?? {};
  const notes = ((link.notes ?? pay.notes ?? {}) as Record<string, unknown>) ?? {};
  const invoiceId = typeof notes.invoice_id === "string" ? notes.invoice_id : null;
  const base = {
    eventId: eventId || `${String(e.event)}:${String(pay.id ?? link.id ?? "")}`,
    providerRef: String(link.id ?? pay.id ?? ""),
    invoiceId,
    amountMinor: Number(pay.amount ?? link.amount_paid ?? link.amount ?? 0),
    currency: String(pay.currency ?? link.currency ?? "").toUpperCase(),
    raw: evt,
  };
  if (e.event === "payment_link.paid" || e.event === "payment.captured") {
    return { ok: true, event: { ...base, type: "payment.succeeded" } };
  }
  if (e.event === "payment.failed") return { ok: true, event: { ...base, type: "payment.failed" } };
  return { ok: true };
}

export const razorpayProvider: PaymentProvider = {
  id: "razorpay",
  configured: () =>
    Boolean(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET && process.env.RAZORPAY_WEBHOOK_SECRET),
  async createCheckout(input) {
    const id = process.env.RAZORPAY_KEY_ID;
    const secret = process.env.RAZORPAY_KEY_SECRET;
    if (!id || !secret) throw new Error("RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET not set");
    const auth = Buffer.from(`${id}:${secret}`).toString("base64");
    const res = await fetch(`${API}/payment_links`, {
      method: "POST",
      headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        amount: input.amountMinor,
        currency: input.currency.toUpperCase(),
        description: input.description.slice(0, 250),
        reference_id: input.invoiceId.slice(0, 40),
        callback_url: input.successUrl,
        callback_method: "get",
        notes: { invoice_id: input.invoiceId, pay_token: input.token },
      }),
    });
    const json = (await res.json()) as { id?: string; short_url?: string; error?: { description?: string } };
    if (!res.ok || !json.short_url || !json.id) throw new Error(json.error?.description ?? `Razorpay error ${res.status}`);
    return { url: json.short_url, providerRef: json.id };
  },
  async verifyWebhook(rawBody, headers) {
    const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
    if (!secret) return { ok: false, error: "RAZORPAY_WEBHOOK_SECRET not set" };
    if (!verifyRazorpaySignature(rawBody, headers.get("x-razorpay-signature"), secret)) {
      return { ok: false, error: "signature mismatch" };
    }
    return parseRazorpayEvent(rawBody, headers.get("x-razorpay-event-id") ?? "");
  },
  async refund() {
    // Stub: payment links map to a payment id that POST /v1/payments/:id/refund would need.
    throw new Error("Razorpay refunds are not wired yet; refund from the Razorpay dashboard and record it manually");
  },
};
