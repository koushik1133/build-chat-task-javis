import { createCipheriv, createECDH, hkdfSync, randomBytes } from "node:crypto";
import { isIP } from "node:net";
import { fromB64url, getVapidConfig, vapidAuthorizationHeader, type VapidConfig } from "./vapid";

/**
 * Web Push message encryption (RFC 8291, aes128gcm / RFC 8188) and delivery
 * (RFC 8030 + VAPID) using node:crypto only — no web-push dependency.
 */

export interface PushSubscriptionJSON {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  expirationTime?: number | null;
}

export const RECORD_SIZE = 4096;
/** Largest payload we accept (push services cap the whole body at 4 KiB). */
export const MAX_PAYLOAD_BYTES = RECORD_SIZE - 16 /* tag */ - 1 /* delimiter */ - 86 /* header */ - 100;

export interface EncryptOptions {
  /** Test hook: fixed 16-byte salt. */
  salt?: Buffer;
  /** Test hook: fixed application-server ECDH private key (32 bytes). */
  localPrivateKey?: Buffer;
}

const INFO_CEK = Buffer.from("Content-Encoding: aes128gcm\0", "ascii");
const INFO_NONCE = Buffer.from("Content-Encoding: nonce\0", "ascii");

/** RFC 8291 §3: derive the content-encryption key and nonce. */
export function deriveKeys(uaPublic: Buffer, authSecret: Buffer, asPublic: Buffer, ecdhSecret: Buffer, salt: Buffer): { cek: Buffer; nonce: Buffer } {
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0", "ascii"), uaPublic, asPublic]);
  const ikm = Buffer.from(hkdfSync("sha256", ecdhSecret, authSecret, keyInfo, 32));
  const cek = Buffer.from(hkdfSync("sha256", ikm, salt, INFO_CEK, 16));
  const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, INFO_NONCE, 12));
  return { cek, nonce };
}

/** Encrypt `payload` for a subscription. Returns the full aes128gcm body (header + single record). */
export function encryptPayload(payload: Buffer | string, p256dh: string, auth: string, opts: EncryptOptions = {}): Buffer {
  const plaintext = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, "utf8");
  if (plaintext.length > MAX_PAYLOAD_BYTES) throw new Error(`push payload too large (${plaintext.length} > ${MAX_PAYLOAD_BYTES} bytes)`);
  const uaPublic = fromB64url(p256dh);
  const authSecret = fromB64url(auth);
  if (uaPublic.length !== 65 || uaPublic[0] !== 0x04) throw new Error("subscription p256dh must be a 65-byte uncompressed point");
  if (authSecret.length !== 16) throw new Error("subscription auth must be 16 bytes");

  const ecdh = createECDH("prime256v1");
  if (opts.localPrivateKey) ecdh.setPrivateKey(opts.localPrivateKey);
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const ecdhSecret = ecdh.computeSecret(uaPublic);
  const salt = opts.salt ?? randomBytes(16);
  if (salt.length !== 16) throw new Error("salt must be 16 bytes");

  const { cek, nonce } = deriveKeys(uaPublic, authSecret, asPublic, ecdhSecret, salt);

  // Single record: payload || 0x02 (last-record delimiter), no extra padding.
  const record = Buffer.concat([plaintext, Buffer.from([0x02])]);
  const cipher = createCipheriv("aes-128-gcm", cek, nonce);
  const ciphertext = Buffer.concat([cipher.update(record), cipher.final(), cipher.getAuthTag()]);

  const header = Buffer.alloc(16 + 4 + 1);
  salt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header[20] = asPublic.length; // 65
  return Buffer.concat([header, asPublic, ciphertext]);
}

export interface SendOptions {
  /** Seconds the push service keeps the message. Default 24h. */
  ttl?: number;
  urgency?: "very-low" | "low" | "normal" | "high";
  topic?: string;
  timeoutMs?: number;
  vapid?: VapidConfig | null;
  fetchImpl?: typeof fetch;
}

export interface SendResult {
  ok: boolean;
  status: number;
  /** 404/410: the subscription is dead and should be deleted. */
  gone: boolean;
  error?: string;
}

/**
 * The server POSTs to whatever endpoint a subscriber registers, so the endpoint
 * is an outbound-request target chosen by the caller. Require https and refuse
 * IP literals, localhost and internal-only suffixes so a subscription cannot
 * be used to reach loopback, link-local (cloud metadata) or private services.
 */
export function isAllowedPushEndpoint(endpoint: string): boolean {
  if (endpoint.length > 2048) return false;
  let u: URL;
  try {
    u = new URL(endpoint);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" || u.username || u.password) return false;
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!host || isIP(host) !== 0) return false;
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".arpa")) return false;
  return host.includes(".");
}

export function isPushSubscription(v: unknown): v is PushSubscriptionJSON {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  const keys = o.keys as Record<string, unknown> | undefined;
  if (typeof o.endpoint !== "string" || !isAllowedPushEndpoint(o.endpoint)) return false;
  if (!keys || typeof keys.p256dh !== "string" || typeof keys.auth !== "string") return false;
  try {
    return fromB64url(keys.p256dh).length === 65 && fromB64url(keys.auth).length === 16;
  } catch {
    return false;
  }
}

export async function sendWebPush(sub: PushSubscriptionJSON, payload: string | Record<string, unknown>, opts: SendOptions = {}): Promise<SendResult> {
  const vapid = opts.vapid === undefined ? getVapidConfig() : opts.vapid;
  if (!vapid) return { ok: false, status: 0, gone: false, error: "push not configured" };
  const body = encryptPayload(typeof payload === "string" ? payload : JSON.stringify(payload), sub.keys.p256dh, sub.keys.auth);
  const headers: Record<string, string> = {
    Authorization: vapidAuthorizationHeader(sub.endpoint, vapid),
    "Content-Encoding": "aes128gcm",
    "Content-Type": "application/octet-stream",
    "Content-Length": String(body.length),
    TTL: String(Math.max(0, Math.floor(opts.ttl ?? 86_400))),
    Urgency: opts.urgency ?? "normal",
  };
  if (opts.topic) headers.Topic = opts.topic.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32);
  const doFetch = opts.fetchImpl ?? fetch;
  try {
    // redirect: "error" — a push service never redirects; following one could re-target the request at an internal host.
    const res = await doFetch(sub.endpoint, { method: "POST", headers, body: new Uint8Array(body), redirect: "error", signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000) });
    const gone = res.status === 404 || res.status === 410;
    if (res.ok) return { ok: true, status: res.status, gone: false };
    const text = await res.text().catch(() => "");
    return { ok: false, status: res.status, gone, error: text.slice(0, 300) || res.statusText };
  } catch (err) {
    return { ok: false, status: 0, gone: false, error: err instanceof Error ? err.message : String(err) };
  }
}
