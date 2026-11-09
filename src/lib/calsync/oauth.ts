import { createHmac, randomBytes, timingSafeEqual } from "crypto";
import type { CalendarProviderId } from "./types";

/** CSRF state for the calendar OAuth dance: random, provider-bound, HMAC-signed, 10-minute TTL. */
export const CALSYNC_STATE_COOKIE = "kh_calsync_oauth";
const TTL_MS = 10 * 60 * 1000;

function secret(): string {
  const configured = process.env.CREDENTIAL_ENCRYPTION_KEY?.trim() || process.env.CRON_SECRET?.trim();
  if (configured) return configured;
  if (process.env.NODE_ENV === "production") throw new Error("Calendar OAuth needs CREDENTIAL_ENCRYPTION_KEY (or CRON_SECRET) to sign its CSRF state.");
  return "calsync-oauth-dev-secret";
}

function sign(payload: string): string {
  return createHmac("sha256", secret()).update(payload).digest("base64url");
}

export function createOauthState(provider: CalendarProviderId, now = Date.now()): string {
  const payload = `${provider}.${now}.${randomBytes(12).toString("base64url")}`;
  return `${payload}.${sign(payload)}`;
}

export function verifyOauthState(state: string | null, cookieValue: string | null | undefined, provider: CalendarProviderId, now = Date.now()): boolean {
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

export function calsyncRedirectUri(provider: CalendarProviderId, requestUrl: string): string {
  const configured = process.env.NEXT_PUBLIC_APP_URL?.trim().replace(/\/$/, "");
  const origin = configured || new URL(requestUrl).origin;
  return `${origin}/api/calsync/callback/${provider}`;
}
