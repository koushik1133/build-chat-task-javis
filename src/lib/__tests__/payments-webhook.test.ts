import { createHmac } from "crypto";
import { describe, expect, it } from "vitest";
import { signSimulatedBody, verifySimulatedWebhook } from "@/lib/payments/simulated";
import { parseStripeEvent, verifyStripeSignature } from "@/lib/payments/stripe";
import { verifyRazorpaySignature } from "@/lib/payments/razorpay";

const SECRET = "test-secret-please-ignore";

describe("simulated provider webhook", () => {
  const body = JSON.stringify({ type: "payment.succeeded", event_id: "e1", provider_ref: "sim_1", invoice_id: "inv1", amount_minor: 1234, currency: "usd" });

  it("accepts a correctly signed body and parses the event", () => {
    const h = new Headers({ "x-simulated-signature": signSimulatedBody(body, SECRET) });
    const r = verifySimulatedWebhook(body, h, SECRET);
    expect(r.ok).toBe(true);
    expect(r.event).toMatchObject({ type: "payment.succeeded", eventId: "e1", providerRef: "sim_1", invoiceId: "inv1", amountMinor: 1234, currency: "USD" });
  });

  it("rejects a bad signature and a tampered body", () => {
    const h = new Headers({ "x-simulated-signature": signSimulatedBody(body, SECRET) });
    expect(verifySimulatedWebhook(body.replace("1234", "1"), h, SECRET).ok).toBe(false);
    expect(verifySimulatedWebhook(body, new Headers({ "x-simulated-signature": "nope" }), SECRET).ok).toBe(false);
    expect(verifySimulatedWebhook(body, new Headers(), SECRET).ok).toBe(false);
  });

  it("fails closed when no secret is configured", () => {
    expect(verifySimulatedWebhook(body, new Headers(), null).ok).toBe(false);
  });

  it("rejects non-integer amounts even when signed", () => {
    const bad = JSON.stringify({ type: "payment.succeeded", event_id: "e2", amount_minor: 12.5, currency: "USD" });
    const h = new Headers({ "x-simulated-signature": signSimulatedBody(bad, SECRET) });
    expect(verifySimulatedWebhook(bad, h, SECRET).ok).toBe(false);
  });
});

describe("stripe signature", () => {
  const raw = JSON.stringify({ id: "evt_1", type: "checkout.session.completed", data: { object: { id: "cs_1", payment_status: "paid", amount_total: 5000, currency: "usd", metadata: { invoice_id: "inv9" } } } });
  const now = 1_700_000_000;
  const sign = (t: number, secret = SECRET) => `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${raw}`).digest("hex")}`;

  it("passes with a fresh, valid signature", () => {
    expect(verifyStripeSignature(raw, sign(now), SECRET, now)).toEqual({ ok: true });
    expect(verifyStripeSignature(raw, sign(now - 299), SECRET, now).ok).toBe(true);
  });

  it("fails with the wrong secret or a tampered body", () => {
    expect(verifyStripeSignature(raw, sign(now, "other"), SECRET, now).ok).toBe(false);
    expect(verifyStripeSignature(raw + " ", sign(now), SECRET, now).ok).toBe(false);
    expect(verifyStripeSignature(raw, null, SECRET, now).ok).toBe(false);
    expect(verifyStripeSignature(raw, "garbage", SECRET, now).ok).toBe(false);
  });

  it("fails when the timestamp is outside the 300s tolerance", () => {
    expect(verifyStripeSignature(raw, sign(now - 301), SECRET, now)).toMatchObject({ ok: false, error: expect.stringContaining("tolerance") });
    expect(verifyStripeSignature(raw, sign(now + 301), SECRET, now).ok).toBe(false);
  });

  it("maps checkout.session.completed to payment.succeeded", () => {
    const r = parseStripeEvent(raw);
    expect(r.ok).toBe(true);
    expect(r.event).toMatchObject({ type: "payment.succeeded", eventId: "evt_1", providerRef: "cs_1", invoiceId: "inv9", amountMinor: 5000, currency: "USD" });
  });

  it("ignores unrelated event types", () => {
    const r = parseStripeEvent(JSON.stringify({ id: "evt_2", type: "customer.created", data: { object: {} } }));
    expect(r).toEqual({ ok: true });
  });
});

describe("razorpay signature", () => {
  it("verifies HMAC-SHA256 hex over the raw body", () => {
    const raw = '{"event":"payment_link.paid"}';
    const sig = createHmac("sha256", SECRET).update(raw).digest("hex");
    expect(verifyRazorpaySignature(raw, sig, SECRET)).toBe(true);
    expect(verifyRazorpaySignature(raw, sig, "other")).toBe(false);
    expect(verifyRazorpaySignature(raw, null, SECRET)).toBe(false);
  });
});
