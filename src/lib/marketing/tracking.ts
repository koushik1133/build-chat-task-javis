import { createHash, createHmac, timingSafeEqual } from "crypto";

/**
 * Signed tracking tokens for the public /api/t/* routes. Tokens carry only
 * opaque ids (recipient / contact / org data id) — never an address — and are
 * HMAC-signed with a key derived from CRON_SECRET so a forged token cannot
 * mark opens, redirect through our domain or unsubscribe someone else.
 *
 * Token = base64url(payload) + "." + base64url(hmac(payload)).
 *   open:        o|<recipientId>
 *   click:       c|<recipientId>|<sha256(url)[0..16]>   (url itself travels in ?u=; must match the hash)
 *   unsubscribe: u|<recipientId>            (campaign recipient)
 *                v|<dataId>|<contactId>     (sequence / direct sends without a recipient row)
 */

export type TrackingPayload =
  | { kind: "open"; recipientId: string }
  | { kind: "click"; recipientId: string; urlHash: string }
  | { kind: "unsub"; recipientId: string }
  | { kind: "unsub_contact"; dataId: string; contactId: string };

function key(): Buffer {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) {
    if (process.env.NODE_ENV === "production") throw new Error("CRON_SECRET is required for tracking links");
    return createHash("sha256").update("marketing-tracking:dev-insecure").digest();
  }
  return createHash("sha256").update(`marketing-tracking:${secret}`).digest();
}

const b64 = (s: string | Buffer) => Buffer.from(s).toString("base64url");

function sign(payload: string): string {
  return `${b64(payload)}.${createHmac("sha256", key()).update(payload).digest("base64url")}`;
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
export function unsubscribeContactToken(dataId: string, contactId: string): string {
  return sign(`v|${dataId}|${contactId}`);
}

const ID_RE = /^[A-Za-z0-9_.:-]{1,120}$/;

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
  const expected = createHmac("sha256", key()).update(payload).digest();
  let given: Buffer;
  try {
    given = Buffer.from(token.slice(dot + 1), "base64url");
  } catch {
    return null;
  }
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  const parts = payload.split("|");
  switch (parts[0]) {
    case "o":
      return parts.length === 2 && ID_RE.test(parts[1]) ? { kind: "open", recipientId: parts[1] } : null;
    case "c":
      return parts.length === 3 && ID_RE.test(parts[1]) && /^[0-9a-f]{16}$/.test(parts[2]) ? { kind: "click", recipientId: parts[1], urlHash: parts[2] } : null;
    case "u":
      return parts.length === 2 && ID_RE.test(parts[1]) ? { kind: "unsub", recipientId: parts[1] } : null;
    case "v":
      return parts.length === 3 && ID_RE.test(parts[1]) && ID_RE.test(parts[2]) ? { kind: "unsub_contact", dataId: parts[1], contactId: parts[2] } : null;
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
export function unsubscribeContactUrl(dataId: string, contactId: string): string {
  return `${trackingOrigin()}/u/${unsubscribeContactToken(dataId, contactId)}`;
}

/** 1×1 transparent GIF. */
export const PIXEL_GIF = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
