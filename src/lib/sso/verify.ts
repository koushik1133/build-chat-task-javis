import { randomBytes, timingSafeEqual } from "crypto";
import { resolveTxt } from "node:dns/promises";
import { query, queryOne } from "@/lib/dsql";

/**
 * SSO domain ownership via DNS. A claim on `acme.com` only routes logins once
 * a TXT record carrying the issued token is published at
 * `_kernelhub-verification.acme.com` or at the apex. The resolver is
 * injectable so the check is unit-testable without network access.
 */

export const VERIFICATION_LABEL = "_kernelhub-verification";
export const TOKEN_PREFIX = "kernelhub-verification=";

export type TxtResolver = (hostname: string) => Promise<string[][]>;

const defaultResolver: TxtResolver = (hostname) => resolveTxt(hostname);

export interface SsoDomainVerification {
  id: string;
  domain: string;
  verification_token: string | null;
  verified_at: string | null;
  last_verify_error: string | null;
}

/** Host and value the admin must publish. */
export function verificationRecord(domain: string, token: string): { host: string; value: string } {
  return { host: `${VERIFICATION_LABEL}.${domain.trim().toLowerCase()}`, value: `${TOKEN_PREFIX}${token}` };
}

/** Issue (or reuse) the token for a domain row; issuing a new one clears verified_at. */
export async function issueVerificationToken(domainId: string, opts: { rotate?: boolean } = {}): Promise<string> {
  const row = await queryOne<{ verification_token: string | null }>(`SELECT verification_token FROM sso_domains WHERE id = $1`, [domainId]);
  if (!row) throw new Error("Domain not found");
  if (row.verification_token && !opts.rotate) return row.verification_token;
  const token = randomBytes(24).toString("base64url");
  await query(`UPDATE sso_domains SET verification_token = $2, verified_at = NULL, last_verify_error = NULL WHERE id = $1`, [domainId, token]);
  return token;
}

function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Look for `kernelhub-verification=<token>` in the TXT records of
 * `_kernelhub-verification.<domain>`, falling back to the apex. Pure lookup:
 * does not touch the database.
 */
export async function verifyDomainDns(domain: string, token: string, resolver: TxtResolver = defaultResolver): Promise<{ ok: boolean; error?: string }> {
  const d = domain.trim().toLowerCase();
  if (!d || !token) return { ok: false, error: "missing domain or token" };
  const expected = `${TOKEN_PREFIX}${token}`;
  const hosts = [`${VERIFICATION_LABEL}.${d}`, d];
  let lastError = "no matching TXT record";
  for (const host of hosts) {
    let records: string[][];
    try {
      records = await resolver(host);
    } catch (err) {
      lastError = err instanceof Error ? `${host}: ${err.message}` : `${host}: lookup failed`;
      continue;
    }
    for (const chunks of records) {
      const value = chunks.join("").trim();
      if (constantTimeEqual(value, expected)) return { ok: true };
    }
  }
  return { ok: false, error: lastError };
}

/** Run the DNS check for a stored domain row and persist the outcome. */
export async function verifyStoredDomain(domainId: string, dataId: string, resolver?: TxtResolver): Promise<SsoDomainVerification> {
  const row = await queryOne<SsoDomainVerification>(
    `SELECT id, domain, verification_token, verified_at, last_verify_error FROM sso_domains WHERE id = $1 AND user_id = $2`,
    [domainId, dataId]
  );
  if (!row) throw new Error("Domain not found");
  const token = row.verification_token ?? (await issueVerificationToken(domainId));
  const result = await verifyDomainDns(row.domain, token, resolver);
  if (result.ok) {
    await query(`UPDATE sso_domains SET verified_at = NOW(), last_verify_error = NULL WHERE id = $1`, [domainId]);
  } else {
    await query(`UPDATE sso_domains SET last_verify_error = $2 WHERE id = $1`, [domainId, (result.error ?? "verification failed").slice(0, 500)]);
  }
  const fresh = await queryOne<SsoDomainVerification>(
    `SELECT id, domain, verification_token, verified_at, last_verify_error FROM sso_domains WHERE id = $1`,
    [domainId]
  );
  return fresh ?? { ...row, verification_token: token, verified_at: result.ok ? new Date().toISOString() : null, last_verify_error: result.error ?? null };
}
