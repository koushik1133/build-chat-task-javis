import { queryOne } from "@/lib/dsql";
import type { Scope } from "@/lib/auth/scope";

/**
 * SSO domain claims. Whoever claims `acme.com` decides where every
 * `@acme.com` login is sent by /api/auth/sso, so a claim must be backed by an
 * address on that domain inside the claiming workspace: the caller's own
 * sign-in email or an active member's. Public mailbox providers can never be
 * claimed — a workspace would otherwise capture every Gmail user's SSO attempt.
 */

export const PUBLIC_MAIL_DOMAINS: ReadonlySet<string> = new Set([
  "gmail.com", "googlemail.com", "yahoo.com", "yahoo.co.uk", "outlook.com", "hotmail.com", "live.com", "msn.com",
  "icloud.com", "me.com", "mac.com", "aol.com", "proton.me", "protonmail.com", "pm.me", "gmx.com", "gmx.de",
  "mail.com", "zoho.com", "yandex.com", "yandex.ru", "fastmail.com", "hey.com",
]);

export function emailDomain(email: string | null | undefined): string | null {
  const at = (email ?? "").trim().toLowerCase().lastIndexOf("@");
  if (at < 0) return null;
  const d = (email ?? "").trim().toLowerCase().slice(at + 1);
  return d || null;
}

export function isPublicMailDomain(domain: string): boolean {
  return PUBLIC_MAIL_DOMAINS.has(domain.trim().toLowerCase());
}

/** True when `scope`'s workspace may claim `domain` (see module doc). */
export async function canClaimSsoDomain(scope: Pick<Scope, "orgId" | "email">, domain: string): Promise<boolean> {
  const wanted = domain.trim().toLowerCase();
  if (!wanted || isPublicMailDomain(wanted)) return false;
  if (emailDomain(scope.email) === wanted) return true;
  const member = await queryOne<{ id: string }>(
    `SELECT id FROM memberships
      WHERE org_id = $1 AND status = 'active' AND invited_email IS NOT NULL
        AND LOWER(invited_email) LIKE '%@' || $2
      LIMIT 1`,
    [scope.orgId, wanted]
  ).catch(() => null);
  return Boolean(member);
}
