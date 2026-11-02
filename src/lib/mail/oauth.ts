import { createHmac, randomBytes, timingSafeEqual } from "crypto";
import type { MailProviderId } from "./types";

/** Minimal env shape so callers (and tests) can pass a plain object instead of process.env. */
type EnvLike = Record<string, string | undefined>;

/**
 * CSRF state for the mail OAuth dance. The state is random, bound to the
 * provider and signed so the callback can reject a forged or replayed value
 * even before it compares it with the cookie.
 */

export const MAIL_STATE_COOKIE = "kh_mail_oauth";
const TTL_MS = 10 * 60 * 1000;

export function oauthStateSecret(env: EnvLike = process.env): string {
  const configured = env.CREDENTIAL_ENCRYPTION_KEY?.trim() || env.CRON_SECRET?.trim();
  if (configured) return configured;
  if (env.NODE_ENV === "production") throw new Error("Mail OAuth needs CREDENTIAL_ENCRYPTION_KEY (or CRON_SECRET) to sign its CSRF state.");
  return "mail-oauth-dev-secret";
}

function secret(): string {
  return oauthStateSecret();
}

function sign(payload: string): string {
  return createHmac("sha256", secret()).update(payload).digest("base64url");
}

export function createOauthState(provider: MailProviderId, now = Date.now()): string {
  const payload = `${provider}.${now}.${randomBytes(12).toString("base64url")}`;
  return `${payload}.${sign(payload)}`;
}

/** True when `state` was minted by us for `provider`, is unexpired, and equals the cookie value. */
export function verifyOauthState(state: string | null, cookieValue: string | null | undefined, provider: MailProviderId, now = Date.now()): boolean {
  if (!state || !cookieValue) return false;
  const a = Buffer.from(state);
  const b = Buffer.from(cookieValue);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
  const parts = state.split(".");
  if (parts.length !== 4) return false;
  const [p, ts, nonce, sig] = parts;
  if (p !== provider) return false;
  const issued = Number(ts);
  if (!Number.isFinite(issued) || now - issued > TTL_MS || issued > now + 60_000) return false;
  const expected = Buffer.from(sign(`${p}.${ts}.${nonce}`));
  const given = Buffer.from(sig);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/** Absolute callback URL for a provider, from NEXT_PUBLIC_APP_URL or the request origin. */
export function mailRedirectUri(provider: MailProviderId, requestUrl: string): string {
  const configured = process.env.NEXT_PUBLIC_APP_URL?.trim().replace(/\/$/, "");
  const origin = configured || new URL(requestUrl).origin;
  return `${origin}/api/mail/callback/${provider}`;
}
