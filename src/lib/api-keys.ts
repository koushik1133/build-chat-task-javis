import { createHash, randomBytes, randomUUID } from "crypto";
import { query, queryOne } from "@/lib/dsql";

/**
 * Personal API keys for the MCP endpoint and public API.
 *
 * The plaintext key is shown exactly once at creation; only its SHA-256 and a
 * short display prefix are stored. Revocation is a soft delete (`revoked_at`)
 * so audit history survives.
 */

export const API_KEY_PREFIX = "kh_";

export interface ApiKeyView {
  id: string;
  name: string;
  key_prefix: string;
  scopes: string[];
  last_used_at: string | null;
  created_at: string;
  revoked_at: string | null;
}

interface ApiKeyRow {
  id: string;
  user_id: string;
  name: string;
  key_prefix: string;
  scopes: string | null;
  last_used_at: string | null;
  created_at: string;
  revoked_at: string | null;
}

export function hashApiKey(plaintext: string): string {
  return createHash("sha256").update(plaintext, "utf8").digest("hex");
}

function parseScopes(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function toView(r: ApiKeyRow): ApiKeyView {
  return {
    id: r.id,
    name: r.name,
    key_prefix: r.key_prefix,
    scopes: parseScopes(r.scopes),
    last_used_at: r.last_used_at,
    created_at: r.created_at,
    revoked_at: r.revoked_at,
  };
}

/** Creates a key and returns the plaintext ONCE. It is never retrievable again. */
export async function createApiKey(
  userId: string,
  name: string,
  scopes: string[] = []
): Promise<{ key: string; record: ApiKeyView }> {
  const plaintext = `${API_KEY_PREFIX}${randomBytes(32).toString("base64url")}`;
  const id = randomUUID();
  const prefix = plaintext.slice(0, 8);
  const now = new Date().toISOString();

  await query(
    `INSERT INTO api_keys (id, user_id, name, key_hash, key_prefix, scopes, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [id, userId, name.trim().slice(0, 60), hashApiKey(plaintext), prefix, JSON.stringify(scopes), now]
  );

  return {
    key: plaintext,
    record: {
      id,
      name: name.trim().slice(0, 60),
      key_prefix: prefix,
      scopes,
      last_used_at: null,
      created_at: now,
      revoked_at: null,
    },
  };
}

/**
 * Resolves a plaintext key to its owner. Returns null for unknown, malformed
 * or revoked keys. Touches `last_used_at` on success (best effort).
 */
export async function verifyApiKey(
  plaintext: string | null | undefined
): Promise<{ userId: string; keyId: string; scopes: string[] } | null> {
  const key = plaintext?.trim();
  if (!key || !key.startsWith(API_KEY_PREFIX) || key.length < 20) return null;

  const row = await queryOne<ApiKeyRow>(
    `SELECT id, user_id, name, key_prefix, scopes, last_used_at, created_at, revoked_at
     FROM api_keys WHERE key_hash = $1 AND revoked_at IS NULL`,
    [hashApiKey(key)]
  ).catch(() => null);
  if (!row) return null;

  void query(`UPDATE api_keys SET last_used_at = NOW() WHERE id = $1`, [row.id]).catch(() => undefined);

  return { userId: row.user_id, keyId: row.id, scopes: parseScopes(row.scopes) };
}

export async function revokeApiKey(userId: string, id: string): Promise<boolean> {
  const rows = await query<{ id: string }>(
    `UPDATE api_keys SET revoked_at = NOW()
     WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL RETURNING id`,
    [id, userId]
  );
  return rows.length > 0;
}

/** Lists a user's keys. Hashes are never returned. */
export async function listApiKeys(userId: string): Promise<ApiKeyView[]> {
  const rows = await query<ApiKeyRow>(
    `SELECT id, user_id, name, key_prefix, scopes, last_used_at, created_at, revoked_at
     FROM api_keys WHERE user_id = $1 ORDER BY created_at DESC`,
    [userId]
  );
  return rows.map(toView);
}
