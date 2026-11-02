import { describe, expect, it } from "vitest";
import { computeSignature, generateWebhookSecret, parseSignatureHeader, signPayload, verifySignature } from "@/lib/webhooks/sign";

const secret = "whsec_test_secret";
const body = JSON.stringify({ id: "d1", type: "invoice.paid", data: { total_minor: 100 } });

describe("webhook signatures", () => {
  it("produces t=,v1= and verifies against the raw body", () => {
    const header = signPayload(secret, body, 1_700_000_000);
    expect(header).toMatch(/^t=1700000000,v1=[0-9a-f]{64}$/);
    expect(parseSignatureHeader(header)).toEqual({ t: 1_700_000_000, v1: [computeSignature(secret, 1_700_000_000, body)] });
    expect(verifySignature(secret, body, header, { now: 1_700_000_010 })).toBe(true);
  });
  it("rejects a tampered body, wrong secret, stale timestamp and malformed headers", () => {
    const header = signPayload(secret, body, 1_700_000_000);
    expect(verifySignature(secret, body + " ", header, { now: 1_700_000_000 })).toBe(false);
    expect(verifySignature("whsec_other", body, header, { now: 1_700_000_000 })).toBe(false);
    expect(verifySignature(secret, body, header, { now: 1_700_000_000 + 301 })).toBe(false);
    expect(verifySignature(secret, body, header, { now: 1_700_000_000 + 299 })).toBe(true);
    expect(verifySignature(secret, body, "v1=abc", { now: 1_700_000_000 })).toBe(false);
    expect(verifySignature(secret, body, null, { now: 1_700_000_000 })).toBe(false);
    expect(verifySignature(secret, body, "t=1700000000,v1=zz", { now: 1_700_000_000 })).toBe(false);
  });
  it("accepts any one of several v1 signatures (secret rotation)", () => {
    const good = computeSignature(secret, 1_700_000_000, body);
    const header = `t=1700000000,v1=${"0".repeat(64)},v1=${good}`;
    expect(verifySignature(secret, body, header, { now: 1_700_000_000 })).toBe(true);
  });
  it("generates distinct prefixed secrets", () => {
    const a = generateWebhookSecret();
    const b = generateWebhookSecret();
    expect(a).toMatch(/^whsec_[A-Za-z0-9_-]{40,}$/);
    expect(a).not.toBe(b);
  });
});
