import { createHash, randomBytes, randomUUID } from "crypto";
import { isUndefinedColumn, query, queryOne } from "@/lib/dsql";

/**
 * Public share links. Only the sha256 of the token is stored; the token
 * itself is shown once (in the link) and never recoverable from the DB.
 */

export type ShareKind = "quote" | "invoice" | "pay" | "portal" | "crew" | "report" | "sign" | "order";

/** `crew` tokens open the mobile crew mode at /m/<token> (today's tasks & bookings, clock in/out). */
/** `report` tokens download a scheduled report as CSV at /api/p/report/<token> (7-day links in digest emails). */
const PATHS: Record<ShareKind, string> = { quote: "/p/q", invoice: "/p/i", pay: "/p/pay", portal: "/p/portal", crew: "/m", report: "/api/p/report", sign: "/p/sign", order: "/shop/order" };
/** `order` tokens open the public order status page; the real path is /shop/<org-slug>/order/<token> (built in src/lib/storefront/orders.ts). */

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function sharePath(kind: ShareKind, token: string): string {
  return `${PATHS[kind]}/${token}`;
}

export function appOrigin(): string {
  return (process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000").replace(/\/$/, "");
}

export interface ShareTokenRow {
  id: string;
  user_id: string;
  kind: ShareKind;
  entity_id: string;
  expires_at: string | null;
  revoked_at: string | null;
  /** Email the link was sent to; when set, OTP flows must use the same address. */
  recipient: string | null;
}

export async function issueShareToken(
  dataId: string,
  kind: ShareKind,
  entityId: string,
  ttlDays = 30,
  opts: { recipient?: string | null } = {}
): Promise<{ token: string; path: string; url: string; expiresAt: string }> {
  const token = randomBytes(24).toString("base64url");
  const expiresAt = new Date(Date.now() + ttlDays * 86_400_000).toISOString();
  const recipient = opts.recipient?.trim().toLowerCase() || null;
  const id = randomUUID();
  if (recipient) {
    // Pre-migration fallback: only when the `recipient` column itself is missing does the token
    // get stored unbound. Any other failure (timeout, conflict, connection reset) propagates, so a
    // transient error can never silently downgrade a recipient-bound link to an open one.
    await query(
      `INSERT INTO share_tokens (id, user_id, kind, entity_id, token_hash, expires_at, recipient) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [id, dataId, kind, entityId, hashToken(token), expiresAt, recipient]
    ).catch((err: unknown) => {
      if (!isUndefinedColumn(err)) throw err;
      console.warn("[share-tokens] share_tokens.recipient column missing; issuing unbound token (apply aws/phase6/a.sql)");
      return query(`INSERT INTO share_tokens (id, user_id, kind, entity_id, token_hash, expires_at) VALUES ($1, $2, $3, $4, $5, $6)`, [id, dataId, kind, entityId, hashToken(token), expiresAt]);
    });
  } else {
    await query(
      `INSERT INTO share_tokens (id, user_id, kind, entity_id, token_hash, expires_at) VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, dataId, kind, entityId, hashToken(token), expiresAt]
    );
  }
  const path = sharePath(kind, token);
  return { token, path, url: `${appOrigin()}${path}`, expiresAt };
}

export interface ShareTokenLookup {
  /** The live row, or null when unknown, expired or revoked. */
  row: ShareTokenRow | null;
  /** True when the token exists but its expiry has passed (so the UI can say "expired" rather than "invalid"). */
  expired: boolean;
}

/**
 * Look up a token and say *why* it is unusable. Revoked tokens report as
 * unknown (not expired) so a revoked link is indistinguishable from a bad one.
 * Touches last_viewed_at on a live hit.
 */
export async function resolveShareTokenDetailed(kind: ShareKind, token: string): Promise<ShareTokenLookup> {
  if (!token || token.length > 128 || !/^[A-Za-z0-9_-]+$/.test(token)) return { row: null, expired: false };
  const row = await queryOne<ShareTokenRow>(
    `SELECT id, user_id, kind, entity_id, expires_at, revoked_at, recipient FROM share_tokens WHERE token_hash = $1 AND kind = $2`,
    [hashToken(token), kind]
  ).catch(() =>
    queryOne<ShareTokenRow>(`SELECT id, user_id, kind, entity_id, expires_at, revoked_at, NULL::text AS recipient FROM share_tokens WHERE token_hash = $1 AND kind = $2`, [hashToken(token), kind])
  );
  if (!row) return { row: null, expired: false };
  if (row.revoked_at) return { row: null, expired: false };
  if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) return { row: null, expired: true };
  query(`UPDATE share_tokens SET last_viewed_at = NOW() WHERE id = $1`, [row.id]).catch(() => undefined);
  return { row, expired: false };
}

/** Look up a token; null when unknown, expired or revoked. Touches last_viewed_at. */
export async function resolveShareToken(kind: ShareKind, token: string): Promise<ShareTokenRow | null> {
  return (await resolveShareTokenDetailed(kind, token)).row;
}

/** Most recent live token for an entity, if any (used to reuse pay links). */
export async function revokeShareTokens(kind: ShareKind, entityId: string): Promise<void> {
  await query(`UPDATE share_tokens SET revoked_at = NOW() WHERE kind = $1 AND entity_id = $2 AND revoked_at IS NULL`, [kind, entityId]);
}
