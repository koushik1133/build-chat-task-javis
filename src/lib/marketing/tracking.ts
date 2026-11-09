import { createHash, createHmac, timingSafeEqual } from "crypto";

/**
 * Signed tracking tokens for the public /api/t/* routes. Tokens carry only
 * opaque ids (recipient / contact / org data id) — never an address — and are
 * HMAC-signed with MARKETING_TRACKING_SECRET (previous and the legacy CRON_SECRET-derived key still verify) so a forged token cannot
 * mark opens, redirect through our domain or unsubscribe someone else.
 *
 * Token = base64url(payload) + "." + base64url(hmac(payload)).
 *   open:        o|<recipientId>
 *   click:       c|<recipientId>|<sha256(url)[0..16]>   (url itself travels in ?u=; must match the hash)
 *   unsubscribe: u|<recipientId>            (campaign recipient)
 *                v|<dataId>|<contactId>|<e|s>  (sequence / direct sends without a recipient row;
 *                                            the channel letter is signed so an SMS opt-out can
 *                                            never be downgraded to an email one; legacy 3-part
 *                                            tokens mean email)
 */

export type TrackingPayload =
  | { kind: "open"; recipientId: string }
  | { kind: "click"; recipientId: string; urlHash: string }
  | { kind: "unsub"; recipientId: string }
  | { kind: "unsub_contact"; dataId: string; contactId: string; channel: TrackingChannel };

export type TrackingChannel = "email" | "sms";

const keyFrom = (secret: string): Buffer => createHash("sha256").update(`marketing-tracking:${secret}`).digest();

/** Signing key: MARKETING_TRACKING_SECRET, else (dev only) a CRON_SECRET-derived key. Throws in production when unset. */
function signingKey(): Buffer {
  const dedicated = process.env.MARKETING_TRACKING_SECRET?.trim();
  if (dedicated) return keyFrom(dedicated);
  if (process.env.NODE_ENV === "production") throw new Error("MARKETING_TRACKING_SECRET is required for tracking links");
  const legacy = process.env.CRON_SECRET?.trim();
  return legacy ? keyFrom(legacy) : createHash("sha256").update("marketing-tracking:dev-insecure").digest();
}

/** Keys accepted when verifying: current, previous (rotation), then the legacy CRON_SECRET-derived key so links already sent keep working. */
function verifyKeys(): Buffer[] {
  const keys: Buffer[] = [];
  const add = (k: Buffer) => {
    if (!keys.some((x) => x.equals(k))) keys.push(k);
  };
  const current = process.env.MARKETING_TRACKING_SECRET?.trim();
  const previous = process.env.MARKETING_TRACKING_SECRET_PREVIOUS?.trim();
  const legacy = process.env.CRON_SECRET?.trim();
  if (current) add(keyFrom(current));
  else if (process.env.NODE_ENV !== "production") add(signingKey()); // dev fallback only; never throws so legacy links still verify
  if (previous) add(keyFrom(previous));
  // Once links sent under the CRON_SECRET-derived key have aged out, set MARKETING_TRACKING_ACCEPT_LEGACY=false
  // (with a dedicated secret) so a leaked cron secret can no longer forge tracking tokens.
  const legacyOff = process.env.MARKETING_TRACKING_ACCEPT_LEGACY?.trim().toLowerCase() === "false" && Boolean(current);
  if (legacy && !legacyOff) add(keyFrom(legacy));
  return keys;
}

const b64 = (s: string | Buffer) => Buffer.from(s).toString("base64url");

function sign(payload: string): string {
  return `${b64(payload)}.${createHmac("sha256", signingKey()).update(payload).digest("base64url")}`;
}

export function urlHash(url: string): string {
  return createHash("sha256").update(url).digest("hex").slice(0, 16);
}

export function openToken(recipientId: string): string {
  return sign(`o|${recipientId}`);
}
export function clickToken(recipientId: string, url: string): string {
  return sign(`c|${recipientId}|${urlHash(url)}`);
}
export function unsubscribeToken(recipientId: string): string {
  return sign(`u|${recipientId}`);
}
export function unsubscribeContactToken(dataId: string, contactId: string, channel: TrackingChannel = "email"): string {
  return sign(`v|${dataId}|${contactId}|${channel === "sms" ? "s" : "e"}`);
}

const ID_RE = /^[A-Za-z0-9_.:-]{1,120}$/;

/** Sign an arbitrary opaque payload with the tracking key (survey links etc.). Verify with `verifySignedPayload`. */
export function signOpaque(payload: string): string {
  return sign(payload);
}

/** Verify the HMAC of a token and return its raw payload string (constant-time compare), or null. */
export function verifySignedPayload(token: string | null | undefined): string | null {
  if (!token || token.length > 600) return null;
  const dot = token.indexOf(".");
  if (dot <= 0) return null;
  let payload: string;
  let given: Buffer;
  try {
    payload = Buffer.from(token.slice(0, dot), "base64url").toString("utf8");
    given = Buffer.from(token.slice(dot + 1), "base64url");
  } catch {
    return null;
  }
  const valid = verifyKeys().some((k) => {
    const expected = createHmac("sha256", k).update(payload).digest();
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
  return valid ? payload : null;
}

/** Verify and decode a token. Returns null on any mismatch — never throws. */
export function verifyToken(token: string | null | undefined): TrackingPayload | null {
  if (!token || token.length > 600) return null;
  const dot = token.indexOf(".");
  if (dot <= 0) return null;
  let payload: string;
  try {
    payload = Buffer.from(token.slice(0, dot), "base64url").toString("utf8");
  } catch {
    return null;
  }
  let given: Buffer;
  try {
    given = Buffer.from(token.slice(dot + 1), "base64url");
  } catch {
    return null;
  }
  const valid = verifyKeys().some((k) => {
    const expected = createHmac("sha256", k).update(payload).digest();
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
  if (!valid) return null;
  const parts = payload.split("|");
  switch (parts[0]) {
    case "o":
      return parts.length === 2 && ID_RE.test(parts[1]) ? { kind: "open", recipientId: parts[1] } : null;
    case "c":
      return parts.length === 3 && ID_RE.test(parts[1]) && /^[0-9a-f]{16}$/.test(parts[2]) ? { kind: "click", recipientId: parts[1], urlHash: parts[2] } : null;
    case "u":
      return parts.length === 2 && ID_RE.test(parts[1]) ? { kind: "unsub", recipientId: parts[1] } : null;
    case "v": {
      if ((parts.length !== 3 && parts.length !== 4) || !ID_RE.test(parts[1]) || !ID_RE.test(parts[2])) return null;
      const ch = parts.length === 4 ? parts[3] : "e";
      if (ch !== "e" && ch !== "s") return null;
      return { kind: "unsub_contact", dataId: parts[1], contactId: parts[2], channel: ch === "s" ? "sms" : "email" };
    }
    default:
      return null;
  }
}

/** Click redirect target is allowed only when its hash matches the signed token and it is http(s). */
export function clickTargetAllowed(payload: TrackingPayload, url: string | null | undefined): url is string {
  if (payload.kind !== "click" || !url || url.length > 4096) return false;
  if (!/^https?:\/\//i.test(url)) return false;
  return urlHash(url) === payload.urlHash;
}

/** Public origin used for links in outbound mail. */
export function trackingOrigin(): string {
  return (process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3001").replace(/\/+$/, "");
}

export function openPixelUrl(recipientId: string): string {
  return `${trackingOrigin()}/api/t/o/${openToken(recipientId)}`;
}
export function clickUrl(recipientId: string, url: string): string {
  return `${trackingOrigin()}/api/t/c/${clickToken(recipientId, url)}?u=${encodeURIComponent(url)}`;
}
export function unsubscribeUrl(recipientId: string): string {
  return `${trackingOrigin()}/u/${unsubscribeToken(recipientId)}`;
}
export function unsubscribeContactUrl(dataId: string, contactId: string, channel: TrackingChannel = "email"): string {
  return `${trackingOrigin()}/u/${unsubscribeContactToken(dataId, contactId, channel)}`;
}

/**
 * RFC 8058 one-click target for the List-Unsubscribe header. Mail providers
 * POST here without a user agent; it must be the API route, not the /u page
 * (a POST to the page would render HTML and withdraw nothing).
 */
export function unsubscribeOneClickUrl(unsubscribePageUrl: string): string {
  return unsubscribePageUrl.replace(/\/u\//, "/api/t/u/");
}

/** 1×1 transparent GIF. */
export const PIXEL_GIF = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
