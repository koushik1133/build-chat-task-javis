import { createECDH, createPrivateKey, createPublicKey, sign, verify, type KeyObject } from "node:crypto";

/**
 * VAPID (RFC 8292) with node:crypto only.
 *
 * Keys are P-256 and stored as base64url: the public key is the 65-byte
 * uncompressed point (what `PushManager.subscribe` wants as
 * `applicationServerKey`), the private key is the 32-byte scalar.
 *
 * Env: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT (mailto: or https:).
 * Generate a pair with `generateVapidKeys()` (see scripts/gen-vapid-keys.mjs).
 */

export const b64url = (buf: ArrayBuffer | Uint8Array | Buffer | string): string =>
  Buffer.from(buf as Uint8Array).toString("base64url");

export function fromB64url(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

export interface VapidKeys {
  publicKey: string; // base64url, 65 bytes
  privateKey: string; // base64url, 32 bytes
}

export function generateVapidKeys(): VapidKeys {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  return { publicKey: b64url(ecdh.getPublicKey()), privateKey: b64url(ecdh.getPrivateKey()) };
}

/** Derive the uncompressed public point from a raw private scalar. */
export function publicKeyFromPrivate(privateKey: string): string {
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(fromB64url(privateKey));
  return b64url(ecdh.getPublicKey());
}

export function parsePublicKeyBytes(publicKey: string): Buffer {
  const bytes = fromB64url(publicKey);
  if (bytes.length !== 65 || bytes[0] !== 0x04) throw new Error("VAPID public key must be a 65-byte uncompressed P-256 point");
  return bytes;
}

function jwkParts(publicKey: string): { x: string; y: string } {
  const pub = parsePublicKeyBytes(publicKey);
  return { x: b64url(pub.subarray(1, 33)), y: b64url(pub.subarray(33, 65)) };
}

export function privateKeyObject(privateKey: string, publicKey = publicKeyFromPrivate(privateKey)): KeyObject {
  const d = fromB64url(privateKey);
  if (d.length !== 32) throw new Error("VAPID private key must be 32 bytes");
  return createPrivateKey({ key: { kty: "EC", crv: "P-256", ...jwkParts(publicKey), d: b64url(d) }, format: "jwk" });
}

export function publicKeyObject(publicKey: string): KeyObject {
  return createPublicKey({ key: { kty: "EC", crv: "P-256", ...jwkParts(publicKey) }, format: "jwk" });
}

export interface VapidJwtInput {
  /** Push service origin, e.g. https://fcm.googleapis.com */
  audience: string;
  /** mailto:ops@example.com or https://example.com */
  subject: string;
  privateKey: string;
  publicKey?: string;
  /** Seconds from now; max 24h per spec. Default 12h. */
  expiresInSec?: number;
  now?: number;
}

/** ES256 JWT in compact form. */
export function createVapidJwt(input: VapidJwtInput): string {
  const exp = Math.floor((input.now ?? Date.now()) / 1000) + Math.min(86_400, Math.max(60, input.expiresInSec ?? 12 * 3600));
  const header = b64url(JSON.stringify({ typ: "JWT", alg: "ES256" }));
  const payload = b64url(JSON.stringify({ aud: input.audience, exp, sub: input.subject }));
  const signingInput = `${header}.${payload}`;
  const key = privateKeyObject(input.privateKey, input.publicKey);
  const sig = sign("sha256", Buffer.from(signingInput), { key, dsaEncoding: "ieee-p1363" });
  return `${signingInput}.${b64url(sig)}`;
}

export function verifyVapidJwt(jwt: string, publicKey: string): boolean {
  const parts = jwt.split(".");
  if (parts.length !== 3) return false;
  return verify("sha256", Buffer.from(`${parts[0]}.${parts[1]}`), { key: publicKeyObject(publicKey), dsaEncoding: "ieee-p1363" }, fromB64url(parts[2]));
}

export function decodeJwt(jwt: string): { header: Record<string, unknown>; payload: Record<string, unknown> } {
  const [h, p] = jwt.split(".");
  return { header: JSON.parse(fromB64url(h).toString("utf8")), payload: JSON.parse(fromB64url(p).toString("utf8")) };
}

/** `Authorization: vapid t=<jwt>, k=<publicKey>` for a given push endpoint. */
export function vapidAuthorizationHeader(endpoint: string, keys: VapidKeys & { subject: string }, now?: number): string {
  const audience = new URL(endpoint).origin;
  const jwt = createVapidJwt({ audience, subject: keys.subject, privateKey: keys.privateKey, publicKey: keys.publicKey, now });
  return `vapid t=${jwt}, k=${keys.publicKey}`;
}

export interface VapidConfig extends VapidKeys {
  subject: string;
}

/** Read VAPID config from env; null when not configured or malformed. */
export function getVapidConfig(): VapidConfig | null {
  const publicKey = process.env.VAPID_PUBLIC_KEY?.trim();
  const privateKey = process.env.VAPID_PRIVATE_KEY?.trim();
  if (!publicKey || !privateKey) return null;
  const subjectRaw = process.env.VAPID_SUBJECT?.trim() || process.env.NEXT_PUBLIC_APP_URL?.trim() || "";
  const subject = subjectRaw.startsWith("mailto:") || subjectRaw.startsWith("https://") ? subjectRaw : subjectRaw.includes("@") ? `mailto:${subjectRaw}` : "";
  if (!subject) return null;
  try {
    parsePublicKeyBytes(publicKey);
    if (fromB64url(privateKey).length !== 32) return null;
  } catch {
    return null;
  }
  return { publicKey, privateKey, subject };
}

export function isPushConfigured(): boolean {
  return getVapidConfig() !== null;
}
