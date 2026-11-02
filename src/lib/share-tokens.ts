import { createHash, randomBytes, randomUUID } from "crypto";
import { query, queryOne } from "@/lib/dsql";

/**
 * Public share links. Only the sha256 of the token is stored; the token
 * itself is shown once (in the link) and never recoverable from the DB.
 */

export type ShareKind = "quote" | "invoice" | "pay" | "portal" | "crew";

/** `crew` tokens open the mobile crew mode at /m/<token> (today's tasks & bookings, clock in/out). */
const PATHS: Record<ShareKind, string> = { quote: "/p/q", invoice: "/p/i", pay: "/p/pay", portal: "/p/portal", crew: "/m" };

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
}

export async function issueShareToken(
  dataId: string,
  kind: ShareKind,
  entityId: string,
  ttlDays = 30
): Promise<{ token: string; path: string; url: string; expiresAt: string }> {
  const token = randomBytes(24).toString("base64url");
  const expiresAt = new Date(Date.now() + ttlDays * 86_400_000).toISOString();
  await query(
    `INSERT INTO share_tokens (id, user_id, kind, entity_id, token_hash, expires_at) VALUES ($1, $2, $3, $4, $5, $6)`,
    [randomUUID(), dataId, kind, entityId, hashToken(token), expiresAt]
  );
  const path = sharePath(kind, token);
  return { token, path, url: `${appOrigin()}${path}`, expiresAt };
}

/** Look up a token; null when unknown, expired or revoked. Touches last_viewed_at. */
export async function resolveShareToken(kind: ShareKind, token: string): Promise<ShareTokenRow | null> {
  if (!token || token.length > 128 || !/^[A-Za-z0-9_-]+$/.test(token)) return null;
  const row = await queryOne<ShareTokenRow>(
    `SELECT id, user_id, kind, entity_id, expires_at, revoked_at FROM share_tokens WHERE token_hash = $1 AND kind = $2`,
    [hashToken(token), kind]
  );
  if (!row) return null;
  if (row.revoked_at) return null;
  if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) return null;
  query(`UPDATE share_tokens SET last_viewed_at = NOW() WHERE id = $1`, [row.id]).catch(() => undefined);
  return row;
}

/** Most recent live token for an entity, if any (used to reuse pay links). */
export async function revokeShareTokens(kind: ShareKind, entityId: string): Promise<void> {
  await query(`UPDATE share_tokens SET revoked_at = NOW() WHERE kind = $1 AND entity_id = $2 AND revoked_at IS NULL`, [kind, entityId]);
}
