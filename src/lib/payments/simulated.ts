import { createHmac, timingSafeEqual } from "crypto";
import type { PaymentProvider, VerifyWebhookResult } from "./types";

/**
 * Simulated provider: no money moves. Checkout is our own /p/pay/<token>
 * page, and "webhooks" are signed with HMAC-SHA256 over the raw body using
 * PAYMENTS_SIMULATED_SECRET (falls back to CRON_SECRET) so the internal
 * simulate-success call goes through the same verified path as a real one.
 */

export function simulatedSecret(): string | null {
  const s = process.env.PAYMENTS_SIMULATED_SECRET?.trim() || process.env.CRON_SECRET?.trim();
  return s || null;
}

export function signSimulatedBody(rawBody: string, secret = simulatedSecret()): string {
  if (!secret) throw new Error("PAYMENTS_SIMULATED_SECRET (or CRON_SECRET) is not set");
  return createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
}

export function verifySimulatedWebhook(rawBody: string, headers: Headers, secret = simulatedSecret()): VerifyWebhookResult {
  if (!secret) return { ok: false, error: "simulated secret not configured" };
  const provided = headers.get("x-simulated-signature") ?? "";
  const expected = signSimulatedBody(rawBody, secret);
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, error: "bad signature" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return { ok: false, error: "invalid json" };
  }
  if (!parsed || typeof parsed !== "object") return { ok: false, error: "invalid payload" };
  const p = parsed as Record<string, unknown>;
  const type = p.type === "payment.succeeded" || p.type === "payment.failed" ? p.type : null;
  if (!type) return { ok: true };
  const amount = Number(p.amount_minor);
  if (!Number.isInteger(amount) || amount < 0) return { ok: false, error: "invalid amount" };
  return {
    ok: true,
    event: {
      type,
      eventId: String(p.event_id ?? ""),
      providerRef: String(p.provider_ref ?? ""),
      invoiceId: typeof p.invoice_id === "string" ? p.invoice_id : null,
      amountMinor: amount,
      currency: String(p.currency ?? "").toUpperCase(),
      raw: parsed,
    },
  };
}

export const simulatedProvider: PaymentProvider = {
  id: "simulated",
  configured: () => true,
  async createCheckout(input) {
    return { url: `/p/pay/${input.token}`, providerRef: `sim_${input.token.slice(0, 24)}` };
  },
  async verifyWebhook(rawBody, headers) {
    return verifySimulatedWebhook(rawBody, headers);
  },
  async refund(input) {
    if (!Number.isInteger(input.amountMinor) || input.amountMinor <= 0) throw new Error("Refund amount must be a positive integer");
    return { refundRef: `simrf_${input.providerRef.slice(0, 20)}_${Date.now().toString(36)}`, status: "succeeded" };
  },
};
