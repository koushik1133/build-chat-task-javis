import { randomUUID } from "crypto";
import { query } from "@/lib/dsql";
import { keysetClause, keysetOrder, type Cursor } from "@/lib/public-api/pagination";

/**
 * Audit log: who changed what, when.
 *
 * `diffRecords` is pure and unit-tested. `recordAudit` never throws — an
 * audit failure must not break the write it describes.
 */

export type AuditDiff = Record<string, [unknown, unknown]>;

export interface AuditScopeLike {
  /** Org data id — the `user_id` under which the org's rows live. */
  dataId: string;
  /** Acting user id. */
  userId?: string | null;
  email?: string | null;
}

export interface AuditInput {
  action: string;
  entity: string;
  entityId?: string | null;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  diff?: AuditDiff | null;
  /** When given, ip / user agent are captured from the request headers. */
  req?: Request | null;
}

export interface AuditRow {
  id: string;
  user_id: string;
  actor_id: string | null;
  actor_email: string | null;
  action: string;
  entity: string;
  entity_id: string | null;
  diff: string | null;
  ip: string | null;
  user_agent: string | null;
  created_at: string;
}

/** Canonical form so `{a:1,b:2}` equals `{b:2,a:1}` and a JSON string equals its parsed object. */
function canonical(v: unknown): string {
  if (typeof v === "string") {
    const t = v.trim();
    if ((t.startsWith("{") && t.endsWith("}")) || (t.startsWith("[") && t.endsWith("]"))) {
      try {
        return canonical(JSON.parse(t));
      } catch {
        /* not JSON; compare as a string */
      }
    }
    return JSON.stringify(v);
  }
  if (v === undefined) return "undefined";
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (v instanceof Date) return JSON.stringify(v.toISOString());
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  const obj = v as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`).join(",")}}`;
}

/**
 * Field-level diff of two records → `{ field: [old, new] }`.
 * Added fields appear as `[undefined, value]`, removed as `[value, undefined]`.
 * Values that are equal after canonicalisation (e.g. a JSON string vs the same
 * object with reordered keys) are not reported.
 */
export function diffRecords(
  before: Record<string, unknown> | null | undefined,
  after: Record<string, unknown> | null | undefined,
  opts: { ignore?: string[] } = {}
): AuditDiff {
  const ignore = new Set(opts.ignore ?? []);
  const a = before ?? {};
  const b = after ?? {};
  const out: AuditDiff = {};
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    if (ignore.has(k)) continue;
    const inA = Object.prototype.hasOwnProperty.call(a, k);
    const inB = Object.prototype.hasOwnProperty.call(b, k);
    if (inA && inB && canonical(a[k]) === canonical(b[k])) continue;
    if (!inA && !inB) continue;
    out[k] = [inA ? a[k] : undefined, inB ? b[k] : undefined];
  }
  return out;
}

function clientIp(req: Request): string | null {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0]?.trim() || null;
  return req.headers.get("x-real-ip");
}

/** Write an audit row. Never throws; failures are logged. */
export async function recordAudit(scope: AuditScopeLike, input: AuditInput): Promise<string | null> {
  const id = randomUUID();
  try {
    const diff =
      input.diff ??
      (input.before !== undefined || input.after !== undefined
        ? diffRecords(input.before ?? null, input.after ?? null)
        : null);
    // Replace `undefined` with null so JSON keeps added/removed sides.
    const diffJson =
      diff && Object.keys(diff).length > 0
        ? JSON.stringify(
            Object.fromEntries(
              Object.entries(diff).map(([k, [o, n]]) => [k, [o === undefined ? null : o, n === undefined ? null : n]])
            )
          )
        : null;
    const ip = input.req ? clientIp(input.req) : null;
    const ua = input.req ? input.req.headers.get("user-agent")?.slice(0, 500) ?? null : null;
    await query(
      `INSERT INTO audit_log (id, user_id, actor_id, actor_email, action, entity, entity_id, diff, ip, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [id, scope.dataId, scope.userId ?? null, scope.email ?? null, input.action, input.entity, input.entityId ?? null, diffJson, ip, ua]
    );
    return id;
  } catch (err) {
    console.error(`[audit] failed to record ${input.action} ${input.entity}:`, err);
    return null;
  }
}

export interface ListAuditOptions {
  entity?: string | null;
  entityId?: string | null;
  limit?: number;
  /** ISO timestamp cursor: rows strictly older than this (legacy; prefer `cursor`). */
  before?: string | null;
  /** Keyset cursor (created_at, id) — stable under same-millisecond writes. */
  cursor?: Cursor | null;
}

export async function listAudit(dataId: string, opts: ListAuditOptions = {}): Promise<AuditRow[]> {
  const limit = Math.min(201, Math.max(1, opts.limit ?? 50));
  const where: string[] = ["user_id = $1"];
  const values: unknown[] = [dataId];
  if (opts.entity) {
    values.push(opts.entity);
    where.push(`entity = $${values.length}`);
  }
  if (opts.entityId) {
    values.push(opts.entityId);
    where.push(`entity_id = $${values.length}`);
  }
  if (opts.before) {
    values.push(opts.before);
    where.push(`created_at < $${values.length}`);
  }
  const keyset = keysetClause(opts.cursor, values);
  values.push(limit);
  return query<AuditRow>(
    `SELECT id, user_id, actor_id, actor_email, action, entity, entity_id, diff, ip, user_agent, created_at
       FROM audit_log WHERE ${where.join(" AND ")}${keyset}
      ORDER BY ${keysetOrder()} LIMIT $${values.length}`,
    values
  );
}
