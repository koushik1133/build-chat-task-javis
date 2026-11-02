import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Webhook signatures (Stripe-style).
 *
 *   X-KernelHub-Signature: t=<unix seconds>,v1=<hex hmac-sha256(secret, `${t}.${body}`)>
 *
 * Receivers recompute the HMAC over the exact raw body and compare in constant
 * time; the timestamp bounds replay to a tolerance window (default 5 minutes).
 */

export const SIGNATURE_HEADER = "X-KernelHub-Signature";
export const EVENT_HEADER = "X-KernelHub-Event";
export const DELIVERY_HEADER = "X-KernelHub-Delivery";
export const DEFAULT_TOLERANCE_SEC = 300;
export const SECRET_PREFIX = "whsec_";

export function generateWebhookSecret(): string {
  return `${SECRET_PREFIX}${randomBytes(32).toString("base64url")}`;
}

export function computeSignature(secret: string, timestamp: number, body: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${body}`, "utf8").digest("hex");
}

/** Build the header value for `body` at `timestamp` (unix seconds). */
export function signPayload(secret: string, body: string, timestamp = Math.floor(Date.now() / 1000)): string {
  return `t=${timestamp},v1=${computeSignature(secret, timestamp, body)}`;
}

export function parseSignatureHeader(header: string | null | undefined): { t: number; v1: string[] } | null {
  if (!header) return null;
  let t: number | null = null;
  const v1: string[] = [];
  for (const part of header.split(",")) {
    const [k, v] = part.split("=", 2).map((s) => s.trim());
    if (k === "t" && /^\d+$/.test(v ?? "")) t = Number(v);
    else if (k === "v1" && /^[0-9a-f]{64}$/i.test(v ?? "")) v1.push(v.toLowerCase());
  }
  if (t === null || v1.length === 0) return null;
  return { t, v1 };
}

/**
 * Verify a received signature. `body` must be the raw request text, read once.
 * Returns false for malformed headers, stale timestamps or mismatching HMACs.
 */
export function verifySignature(
  secret: string,
  body: string,
  header: string | null | undefined,
  opts: { toleranceSec?: number; now?: number } = {}
): boolean {
  const parsed = parseSignatureHeader(header);
  if (!parsed) return false;
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const tolerance = opts.toleranceSec ?? DEFAULT_TOLERANCE_SEC;
  if (Math.abs(now - parsed.t) > tolerance) return false;
  const expected = Buffer.from(computeSignature(secret, parsed.t, body), "hex");
  return parsed.v1.some((sig) => {
    const got = Buffer.from(sig, "hex");
    return got.length === expected.length && timingSafeEqual(got, expected);
  });
}
