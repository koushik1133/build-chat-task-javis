import { describe, expect, it } from "vitest";
import { createDecipheriv, createECDH, hkdfSync, randomBytes } from "node:crypto";
import {
  createVapidJwt,
  decodeJwt,
  fromB64url,
  generateVapidKeys,
  getVapidConfig,
  parsePublicKeyBytes,
  publicKeyFromPrivate,
  vapidAuthorizationHeader,
  verifyVapidJwt,
} from "@/lib/push/vapid";
import { encryptPayload, isPushSubscription, MAX_PAYLOAD_BYTES, RECORD_SIZE, sendWebPush } from "@/lib/push/send";

describe("VAPID keys", () => {
  it("generates a 65-byte public point and 32-byte private scalar, round-trippable", () => {
    const { publicKey, privateKey } = generateVapidKeys();
    expect(parsePublicKeyBytes(publicKey)).toHaveLength(65);
    expect(fromB64url(privateKey)).toHaveLength(32);
    expect(publicKeyFromPrivate(privateKey)).toBe(publicKey);
    // base64url: no padding, no + or /
    expect(publicKey).not.toMatch(/[+/=]/);
  });

  it("rejects malformed public keys", () => {
    expect(() => parsePublicKeyBytes("AAAA")).toThrow(/65-byte/);
  });
});

describe("VAPID JWT", () => {
  const keys = generateVapidKeys();

  it("has three base64url parts, an ES256 header and aud/exp/sub claims", () => {
    const now = 1_700_000_000_000;
    const jwt = createVapidJwt({ audience: "https://fcm.googleapis.com", subject: "mailto:ops@example.com", ...keys, now, expiresInSec: 3600 });
    const parts = jwt.split(".");
    expect(parts).toHaveLength(3);
    for (const p of parts) expect(p).toMatch(/^[A-Za-z0-9_-]+$/);
    const { header, payload } = decodeJwt(jwt);
    expect(header).toEqual({ typ: "JWT", alg: "ES256" });
    expect(payload.aud).toBe("https://fcm.googleapis.com");
    expect(payload.sub).toBe("mailto:ops@example.com");
    expect(payload.exp).toBe(1_700_000_000 + 3600);
    // ES256 signatures are raw r||s (64 bytes), not DER.
    expect(fromB64url(parts[2])).toHaveLength(64);
  });

  it("verifies with the matching public key and fails with another", () => {
    const jwt = createVapidJwt({ audience: "https://updates.push.services.mozilla.com", subject: "https://example.com", ...keys });
    expect(verifyVapidJwt(jwt, keys.publicKey)).toBe(true);
    expect(verifyVapidJwt(jwt, generateVapidKeys().publicKey)).toBe(false);
    expect(verifyVapidJwt(jwt.slice(0, -4) + "AAAA", keys.publicKey)).toBe(false);
  });

  it("caps expiry at 24h and builds the Authorization header from the endpoint origin", () => {
    const jwt = createVapidJwt({ audience: "https://x.io", subject: "mailto:a@b.c", ...keys, now: 0, expiresInSec: 999_999 });
    expect(decodeJwt(jwt).payload.exp).toBe(86_400);
    const auth = vapidAuthorizationHeader("https://fcm.googleapis.com/fcm/send/abc123", { ...keys, subject: "mailto:a@b.c" });
    expect(auth).toMatch(/^vapid t=[A-Za-z0-9_.-]+, k=[A-Za-z0-9_-]+$/);
    expect(auth.endsWith(`k=${keys.publicKey}`)).toBe(true);
    expect(decodeJwt(auth.slice(8).split(",")[0]).payload.aud).toBe("https://fcm.googleapis.com");
  });

  it("reads config from env and rejects partial config", () => {
    const prev = { ...process.env };
    try {
      delete process.env.VAPID_PUBLIC_KEY;
      delete process.env.VAPID_PRIVATE_KEY;
      expect(getVapidConfig()).toBeNull();
      process.env.VAPID_PUBLIC_KEY = keys.publicKey;
      process.env.VAPID_PRIVATE_KEY = keys.privateKey;
      process.env.VAPID_SUBJECT = "ops@example.com";
      expect(getVapidConfig()).toEqual({ ...keys, subject: "mailto:ops@example.com" });
      process.env.VAPID_PRIVATE_KEY = "bad";
      expect(getVapidConfig()).toBeNull();
    } finally {
      process.env = prev;
    }
  });
});

/** Test-side RFC 8291 decrypt using the user agent's private key. */
function decryptAes128gcm(body: Buffer, uaPrivate: Buffer, uaPublic: Buffer, authSecret: Buffer): Buffer {
  const salt = body.subarray(0, 16);
  const rs = body.readUInt32BE(16);
  const idlen = body[20];
  const asPublic = body.subarray(21, 21 + idlen);
  const ciphertext = body.subarray(21 + idlen);
  expect(rs).toBe(RECORD_SIZE);
  expect(idlen).toBe(65);

  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(uaPrivate);
  const secret = ecdh.computeSecret(asPublic);
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic]);
  const ikm = Buffer.from(hkdfSync("sha256", secret, authSecret, keyInfo, 32));
  const cek = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
  const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
  const d = createDecipheriv("aes-128-gcm", cek, nonce);
  d.setAuthTag(ciphertext.subarray(ciphertext.length - 16));
  const plain = Buffer.concat([d.update(ciphertext.subarray(0, ciphertext.length - 16)), d.final()]);
  // Strip padding delimiter (0x02 for the last record) and trailing zeros.
  let end = plain.length - 1;
  while (end >= 0 && plain[end] === 0) end--;
  expect(plain[end]).toBe(0x02);
  return plain.subarray(0, end);
}

describe("aes128gcm payload encryption (RFC 8291)", () => {
  const ua = createECDH("prime256v1");
  ua.generateKeys();
  const uaPublic = ua.getPublicKey();
  const authSecret = randomBytes(16);
  const sub = { endpoint: "https://push.example/abc", keys: { p256dh: uaPublic.toString("base64url"), auth: authSecret.toString("base64url") } };

  it("round-trips through a user-agent-side decrypt", () => {
    const payload = JSON.stringify({ title: "Hello", body: "Wörld ✓", url: "/tasks" });
    const body = encryptPayload(payload, sub.keys.p256dh, sub.keys.auth);
    expect(body.length).toBe(21 + 65 + Buffer.byteLength(payload) + 1 + 16);
    expect(decryptAes128gcm(body, ua.getPrivateKey(), uaPublic, authSecret).toString("utf8")).toBe(payload);
  });

  it("is deterministic with a fixed salt and server key, and different otherwise", () => {
    const salt = randomBytes(16);
    const localPrivateKey = createECDH("prime256v1");
    localPrivateKey.generateKeys();
    const a = encryptPayload("x", sub.keys.p256dh, sub.keys.auth, { salt, localPrivateKey: localPrivateKey.getPrivateKey() });
    const b = encryptPayload("x", sub.keys.p256dh, sub.keys.auth, { salt, localPrivateKey: localPrivateKey.getPrivateKey() });
    expect(a.equals(b)).toBe(true);
    expect(a.subarray(0, 16).equals(salt)).toBe(true);
    expect(encryptPayload("x", sub.keys.p256dh, sub.keys.auth).equals(a)).toBe(false);
  });

  it("rejects oversize payloads and malformed keys", () => {
    expect(() => encryptPayload("a".repeat(MAX_PAYLOAD_BYTES + 1), sub.keys.p256dh, sub.keys.auth)).toThrow(/too large/);
    expect(() => encryptPayload("x", "AAAA", sub.keys.auth)).toThrow(/p256dh/);
    expect(() => encryptPayload("x", sub.keys.p256dh, "AAAA")).toThrow(/auth/);
  });

  it("validates subscription JSON", () => {
    expect(isPushSubscription(sub)).toBe(true);
    expect(isPushSubscription({ ...sub, endpoint: "http://insecure" })).toBe(false);
    expect(isPushSubscription({ endpoint: sub.endpoint })).toBe(false);
  });

  it("sendWebPush posts the encrypted body with VAPID + aes128gcm headers and flags dead endpoints", async () => {
    const vapid = { ...generateVapidKeys(), subject: "mailto:a@b.c" };
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response("gone", { status: 410 });
    }) as unknown as typeof fetch;
    const res = await sendWebPush(sub, { title: "t" }, { vapid, fetchImpl, ttl: 60, topic: "crew!" });
    expect(res).toMatchObject({ ok: false, status: 410, gone: true });
    const h = calls[0].init.headers as Record<string, string>;
    expect(h["Content-Encoding"]).toBe("aes128gcm");
    expect(h.Authorization).toMatch(/^vapid t=/);
    expect(h.TTL).toBe("60");
    expect(h.Topic).toBe("crew");
    expect(calls[0].url).toBe(sub.endpoint);
    expect(await sendWebPush(sub, "x", { vapid: null })).toMatchObject({ ok: false, status: 0, error: "push not configured" });
  });
});
