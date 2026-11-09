import { createHash, randomUUID } from "crypto";
import { recordErrorCapture } from "@/lib/metrics/registry";

/**
 * Deduplicated error capture into `app_errors`.
 *
 * Fingerprint = sha1(route + first line of the message), so the same failure
 * on the same route is one row with a rising `count`, not a flood. The
 * capture itself can never throw (it would otherwise mask the original error)
 * and never blocks a response for long: callers should `void captureError(...)`.
 */

export interface CaptureContext {
  /** Route or page identifier, e.g. "/api/v1/contacts" or "client:/settings". */
  route: string;
  method?: string | null;
  status?: number | null;
  /** Tenant data id (scope.dataId) that owns the error; null for anonymous captures. */
  userId?: string | null;
}

export const STACK_MAX_CHARS = 4_000;
const MESSAGE_MAX_CHARS = 2_000;

/**
 * `ownerId` (the tenant data id) is part of the fingerprint so two workspaces
 * hitting the same failure get separate rows: a row is only ever shown to the
 * workspace it belongs to, and one tenant can never inflate or pre-claim
 * another tenant's row. Anonymous captures (no owner) share one bucket.
 */
export function errorFingerprint(route: string, message: string, ownerId: string | null = null): string {
  const firstLine = (message.split(/\r?\n/)[0] ?? "").trim().slice(0, 500);
  return createHash("sha1").update(`${ownerId ?? ""}\n${route.trim()}\n${firstLine}`, "utf8").digest("hex");
}

export interface NormalisedError { message: string; stack: string | null }

export function normaliseError(err: unknown): NormalisedError {
  if (err instanceof Error) {
    return { message: (err.message || err.name || "Error").slice(0, MESSAGE_MAX_CHARS), stack: err.stack ? err.stack.slice(0, STACK_MAX_CHARS) : null };
  }
  if (typeof err === "string") return { message: err.slice(0, MESSAGE_MAX_CHARS), stack: null };
  try {
    return { message: JSON.stringify(err).slice(0, MESSAGE_MAX_CHARS), stack: null };
  } catch {
    return { message: "Unknown error", stack: null };
  }
}

/** Record an error. Returns the row id (existing or new) or null when storage failed. Never throws. */
export async function captureError(err: unknown, ctx: CaptureContext): Promise<string | null> {
  recordErrorCapture();
  try {
    const { message, stack } = normaliseError(err);
    const route = ctx.route.slice(0, 300);
    const fingerprint = errorFingerprint(route, message, ctx.userId ?? null);
    const { query, withRetry } = await import("@/lib/dsql");
    return await withRetry(async () => {
      const updated = await query<{ id: string }>(
        `UPDATE app_errors SET count = count + 1, last_seen = NOW(), status = COALESCE($2, status), user_id = COALESCE(user_id, $3)
          WHERE fingerprint = $1 RETURNING id`,
        [fingerprint, ctx.status ?? null, ctx.userId ?? null]
      );
      if (updated[0]) return updated[0].id;
      const id = randomUUID();
      try {
        await query(
          `INSERT INTO app_errors (id, user_id, route, method, status, message, stack, fingerprint, count, first_seen, last_seen)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 1, NOW(), NOW())`,
          [id, ctx.userId ?? null, route, ctx.method?.slice(0, 10) ?? null, ctx.status ?? null, message, stack, fingerprint]
        );
        return id;
      } catch (insertErr) {
        // Two concurrent first occurrences: the unique fingerprint index rejects
        // the second INSERT, so fold this occurrence into the row that won.
        const raced = await query<{ id: string }>(
          `UPDATE app_errors SET count = count + 1, last_seen = NOW() WHERE fingerprint = $1 RETURNING id`,
          [fingerprint]
        );
        if (raced[0]) return raced[0].id;
        throw insertErr;
      }
    });
  } catch (e) {
    console.warn("[errors] capture failed", e instanceof Error ? e.message : e);
    return null;
  }
}

export interface AppErrorRow {
  id: string;
  user_id: string | null;
  route: string;
  method: string | null;
  status: number | null;
  message: string;
  stack: string | null;
  fingerprint: string;
  count: number;
  first_seen: string;
  last_seen: string;
}

/**
 * Most recent errors for ONE workspace. Rows are tenant-scoped by `user_id`
 * (the org data id); anonymous rows (user_id IS NULL, e.g. unauthenticated
 * client reports) are never shown to any tenant because their content is
 * attacker-controlled and not attributable.
 */
export async function listRecentErrors(limit = 50, dataId: string): Promise<AppErrorRow[]> {
  if (!dataId) return [];
  const { query } = await import("@/lib/dsql");
  const rows = await query<AppErrorRow>(
    `SELECT id, user_id, route, method, status, message, stack, fingerprint, count, first_seen, last_seen
       FROM app_errors WHERE user_id = $2 ORDER BY last_seen DESC LIMIT $1`,
    [Math.min(Math.max(limit, 1), 200), dataId]
  );
  return rows.map((r) => ({ ...r, count: Number(r.count), status: r.status === null ? null : Number(r.status) }));
}
