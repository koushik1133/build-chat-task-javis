import { createHash } from "crypto";
import { query, queryOne } from "@/lib/dsql";
import { ApiError } from "./envelope";

/**
 * Idempotent POSTs for the public API.
 *
 * A client sends `Idempotency-Key: <token>`; the first call runs and its
 * response is stored under (user_id, key). Replays with the same key and the
 * same request hash get the stored response back with `Idempotent-Replay: true`.
 * The same key with a different body is a 422. Keys expire after 24 hours.
 */

export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
export const IDEMPOTENCY_HEADER = "idempotency-key";

export interface StoredResponse {
  status: number;
  body: unknown;
}

interface Row {
  id: string;
  request_hash: string;
  status: string;
  response_json: string | null;
  created_at: string | Date;
}

export function requestHash(method: string, path: string, body: string): string {
  return createHash("sha256").update(`${method.toUpperCase()} ${path}\n${body}`, "utf8").digest("hex");
}

/** Keys are opaque client tokens; bound their size so the unique index stays cheap. */
export function isValidIdempotencyKey(key: string | null | undefined): key is string {
  return typeof key === "string" && key.length >= 1 && key.length <= 255 && !/[\s\u0000]/.test(key);
}

function isExpired(createdAt: string | Date, now = Date.now()): boolean {
  const t = createdAt instanceof Date ? createdAt.getTime() : new Date(createdAt).getTime();
  return !Number.isFinite(t) || now - t > IDEMPOTENCY_TTL_MS;
}

/**
 * Run `fn` once per (userId, key). Returns `{ replayed: true }` with the stored
 * response when the same request was already completed.
 */
export async function withIdempotency(
  userId: string,
  key: string,
  hash: string,
  fn: () => Promise<StoredResponse>
): Promise<StoredResponse & { replayed: boolean }> {
  const existing = await queryOne<Row>(
    `SELECT id, request_hash, status, response_json, created_at FROM api_idempotency WHERE user_id = $1 AND key = $2`,
    [userId, key]
  );

  if (existing && !isExpired(existing.created_at)) {
    if (existing.request_hash !== hash) {
      throw new ApiError(422, "idempotency_mismatch", "Idempotency-Key was already used with a different request body");
    }
    if (existing.status === "completed" && existing.response_json) {
      const stored = JSON.parse(existing.response_json) as StoredResponse;
      return { ...stored, replayed: true };
    }
    throw new ApiError(409, "idempotency_in_progress", "A request with this Idempotency-Key is still being processed", undefined, { "Retry-After": "2" });
  }

  if (existing) {
    // Expired: free the key for reuse.
    await query(`DELETE FROM api_idempotency WHERE id = $1`, [existing.id]).catch(() => undefined);
  }

  // Claim the key. A concurrent claim loses on the unique index and reads back the winner.
  let claimed = true;
  try {
    await query(`INSERT INTO api_idempotency (user_id, key, request_hash, status) VALUES ($1, $2, $3, 'pending')`, [userId, key, hash]);
  } catch {
    claimed = false;
  }
  if (!claimed) {
    const winner = await queryOne<Row>(
      `SELECT id, request_hash, status, response_json, created_at FROM api_idempotency WHERE user_id = $1 AND key = $2`,
      [userId, key]
    );
    if (winner?.status === "completed" && winner.response_json && winner.request_hash === hash) {
      return { ...(JSON.parse(winner.response_json) as StoredResponse), replayed: true };
    }
    throw new ApiError(409, "idempotency_in_progress", "A request with this Idempotency-Key is still being processed", undefined, { "Retry-After": "2" });
  }

  try {
    const result = await fn();
    if (result.status < 500) {
      await query(`UPDATE api_idempotency SET status = 'completed', response_json = $3 WHERE user_id = $1 AND key = $2`, [
        userId,
        key,
        JSON.stringify({ status: result.status, body: result.body }),
      ]).catch((err) => console.error("[api/v1] idempotency store failed:", err));
    } else {
      await query(`DELETE FROM api_idempotency WHERE user_id = $1 AND key = $2`, [userId, key]).catch(() => undefined);
    }
    return { ...result, replayed: false };
  } catch (err) {
    // Let the client retry a failed attempt with the same key.
    await query(`DELETE FROM api_idempotency WHERE user_id = $1 AND key = $2`, [userId, key]).catch(() => undefined);
    throw err;
  }
}

/** Housekeeping hook (cron-safe): drop rows older than the TTL. */
export async function purgeExpiredIdempotency(): Promise<number> {
  const rows = await query<{ id: string }>(`DELETE FROM api_idempotency WHERE created_at < $1 RETURNING id`, [
    new Date(Date.now() - IDEMPOTENCY_TTL_MS).toISOString(),
  ]);
  return rows.length;
}
