import { createHmac, randomBytes, timingSafeEqual } from "crypto";
import type { LiveAccountingProviderId } from "./types";

type EnvLike = Record<string, string | undefined>;

/**
 * CSRF state for the accounting OAuth dance (same shape as the mail flow, kept
 * separate so the two modules do not share a cookie or a secret derivation).
 */
export const ACCOUNTING_STATE_COOKIE = "kh_acct_oauth";
const TTL_MS = 10 * 60 * 1000;

export function accountingStateSecret(env: EnvLike = process.env): string {
  const configured = env.CREDENTIAL_ENCRYPTION_KEY?.trim() || env.CRON_SECRET?.trim();
  if (configured) return `acct:${configured}`;
  if (env.NODE_ENV === "production") throw new Error("Accounting OAuth needs CREDENTIAL_ENCRYPTION_KEY (or CRON_SECRET) to sign its CSRF state.");
  return "accounting-oauth-dev-secret";
}

function sign(payload: string, secret = accountingStateSecret()): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

export function createAccountingState(provider: LiveAccountingProviderId, now = Date.now()): string {
  const payload = `${provider}.${now}.${randomBytes(12).toString("base64url")}`;
  return `${payload}.${sign(payload)}`;
}

export function verifyAccountingState(state: string | null, cookieValue: string | null | undefined, provider: LiveAccountingProviderId, now = Date.now()): boolean {
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

export function accountingRedirectUri(provider: LiveAccountingProviderId, requestUrl: string): string {
  const configured = process.env.NEXT_PUBLIC_APP_URL?.trim().replace(/\/$/, "");
  const origin = configured || new URL(requestUrl).origin;
  return `${origin}/api/accounting/callback/${provider}`;
}
