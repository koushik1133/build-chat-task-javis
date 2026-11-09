import { randomUUID } from "crypto";
import { z } from "zod";
import { query, queryOne } from "@/lib/dsql";
import { CurrencySchema } from "@/lib/money/items";
import { keysetClause, keysetOrder, type Cursor } from "@/lib/public-api/pagination";

/**
 * Time tracking. An entry with `ended_at = NULL` is a running timer; stopping
 * it fills `ended_at` and `minutes`. `rate_minor` is per hour so the billable
 * value of an entry is minutes / 60 × rate (rounded half-up to minor units).
 */

export interface TimeEntryRow {
  id: string;
  user_id: string;
  member_id: string | null;
  ref_kind: string | null;
  ref_id: string | null;
  description: string | null;
  started_at: string;
  ended_at: string | null;
  minutes: number | null;
  rate_minor: string | number;
  currency: string;
  billable: boolean;
  invoice_id: string | null;
  created_at: string;
}

export interface TimeEntryDTO {
  id: string;
  member_id: string | null;
  ref_kind: string | null;
  ref_id: string | null;
  description: string | null;
  started_at: string;
  ended_at: string | null;
  minutes: number | null;
  running: boolean;
  rate_minor: number;
  currency: string;
  /** minutes/60 × rate, 0 while running. */
  value_minor: number;
  billable: boolean;
  invoice_id: string | null;
  created_at: string;
}

/** Pure: value of `minutes` at an hourly rate, rounded half-up. */
export function timeValueMinor(minutes: number | null | undefined, rateMinor: number): number {
  const m = Number(minutes) || 0;
  if (m <= 0 || !rateMinor) return 0;
  return Math.floor((m * Number(rateMinor)) / 60 + 0.5);
}

/** Pure: whole minutes between two instants, never negative, at least 1 for any positive span. */
export function minutesBetween(startIso: string, endIso: string): number {
  const ms = new Date(endIso).getTime() - new Date(startIso).getTime();
  if (!Number.isFinite(ms) || ms <= 0) return 0;
  return Math.max(1, Math.round(ms / 60_000));
}

export function toTimeEntryDTO(r: TimeEntryRow): TimeEntryDTO {
  const rate_minor = Number(r.rate_minor);
  const minutes = r.minutes === null || r.minutes === undefined ? null : Number(r.minutes);
  return {
    id: r.id,
    member_id: r.member_id,
    ref_kind: r.ref_kind,
    ref_id: r.ref_id,
    description: r.description,
    started_at: r.started_at,
    ended_at: r.ended_at,
    minutes,
    running: !r.ended_at,
    rate_minor,
    currency: r.currency,
    value_minor: timeValueMinor(minutes, rate_minor),
    billable: Boolean(r.billable),
    invoice_id: r.invoice_id,
    created_at: r.created_at,
  };
}

const RefKind = z.string().trim().min(1).max(40).regex(/^[a-z_]+$/);

export const TimeEntryInputSchema = z
  .object({
    member_id: z.string().trim().max(100).nullable().optional(),
    ref_kind: RefKind.nullable().optional(),
    ref_id: z.string().trim().max(100).nullable().optional(),
    description: z.string().trim().max(2000).nullable().optional(),
    /** Defaults to now. With no ended_at/minutes this starts a running timer. */
    started_at: z.string().datetime({ offset: true }).optional(),
    ended_at: z.string().datetime({ offset: true }).nullable().optional(),
    /** Alternative to ended_at: a fixed duration. */
    minutes: z.number().int().min(1).max(100_000).optional(),
    rate_minor: z.number().int().min(0).max(1_000_000_000).default(0),
    currency: CurrencySchema.default("USD"),
    billable: z.boolean().default(true),
  })
  .strict();
export type TimeEntryInput = z.infer<typeof TimeEntryInputSchema>;
export const TimeEntryPatchSchema = TimeEntryInputSchema.partial().strict();
export type TimeEntryPatch = z.infer<typeof TimeEntryPatchSchema>;

export interface ListTimeOpts {
  from?: string | null;
  to?: string | null;
  refKind?: string | null;
  refId?: string | null;
  memberId?: string | null;
  runningOnly?: boolean;
  unbilledOnly?: boolean;
  limit?: number;
  /** "started" (default: running first, newest start) or "created" (newest first, cursor-friendly). */
  order?: "started" | "created";
  cursor?: Cursor | null;
}

export async function listTimeEntries(dataId: string, opts: ListTimeOpts = {}): Promise<TimeEntryDTO[]> {
  const params: unknown[] = [dataId];
  let sql = `SELECT * FROM time_entries WHERE user_id = $1`;
  if (opts.from) {
    params.push(opts.from);
    sql += ` AND started_at >= $${params.length}`;
  }
  if (opts.to) {
    params.push(opts.to);
    sql += ` AND started_at <= $${params.length}`;
  }
  if (opts.refKind && opts.refId) {
    params.push(opts.refKind, opts.refId);
    sql += ` AND ref_kind = $${params.length - 1} AND ref_id = $${params.length}`;
  }
  if (opts.memberId) {
    params.push(opts.memberId);
    sql += ` AND member_id = $${params.length}`;
  }
  if (opts.runningOnly) sql += ` AND ended_at IS NULL`;
  if (opts.unbilledOnly) sql += ` AND billable = TRUE AND invoice_id IS NULL AND ended_at IS NOT NULL`;
  if (opts.order === "created") sql += keysetClause(opts.cursor, params);
  params.push(Math.min(Math.max(opts.limit ?? 200, 1), 1000));
  sql += opts.order === "created" ? ` ORDER BY ${keysetOrder()} LIMIT $${params.length}` : ` ORDER BY (ended_at IS NULL) DESC, started_at DESC LIMIT $${params.length}`;
  return (await query<TimeEntryRow>(sql, params)).map(toTimeEntryDTO);
}

export async function getTimeEntry(dataId: string, id: string): Promise<TimeEntryDTO | null> {
  const row = await queryOne<TimeEntryRow>(`SELECT * FROM time_entries WHERE id = $1 AND user_id = $2`, [id, dataId]);
  return row ? toTimeEntryDTO(row) : null;
}

/**
 * Create an entry. With neither `ended_at` nor `minutes` the entry is a running
 * timer; a member can only have one running timer at a time.
 */
export async function createTimeEntry(dataId: string, input: TimeEntryInput, actorId?: string | null): Promise<TimeEntryDTO> {
  const started_at = input.started_at ?? new Date().toISOString();
  const member = input.member_id ?? actorId ?? null;
  let ended_at: string | null = input.ended_at ?? null;
  let minutes: number | null = input.minutes ?? null;
  if (ended_at && minutes === null) minutes = minutesBetween(started_at, ended_at);
  if (minutes !== null && !ended_at) ended_at = new Date(new Date(started_at).getTime() + minutes * 60_000).toISOString();
  if (ended_at && minutes !== null && minutes <= 0) throw new Error("ended_at must be after started_at");

  const id = randomUUID();
  const values = [id, dataId, member, input.ref_kind ?? null, input.ref_id ?? null, input.description ?? null, started_at, ended_at, minutes, input.rate_minor, input.currency, input.billable];
  if (!ended_at && member) {
    // Starting a timer: one running timer per member. A SELECT-then-INSERT
    // lets two concurrent starts both pass, so the uniqueness check is part
    // of the INSERT itself (zero rows inserted → someone else is running).
    const inserted = await query<{ id: string }>(
      `INSERT INTO time_entries (id, user_id, member_id, ref_kind, ref_id, description, started_at, ended_at, minutes, rate_minor, currency, billable)
       SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12
        WHERE NOT EXISTS (SELECT 1 FROM time_entries WHERE user_id = $2 AND member_id = $3 AND ended_at IS NULL)
       RETURNING id`,
      values
    );
    if (inserted.length === 0) throw new Error("A timer is already running; stop it first");
  } else {
    await query(
      `INSERT INTO time_entries (id, user_id, member_id, ref_kind, ref_id, description, started_at, ended_at, minutes, rate_minor, currency, billable)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      values
    );
  }
  const e = await getTimeEntry(dataId, id);
  if (!e) throw new Error("Time entry vanished after insert");
  return e;
}

/** Stop a running timer. Idempotent: an already-stopped entry is returned as-is. */
export async function stopTimer(dataId: string, id: string, endedAt?: string): Promise<TimeEntryDTO> {
  const e = await getTimeEntry(dataId, id);
  if (!e) throw new Error("Time entry not found");
  if (!e.running) return e;
  const end = endedAt ?? new Date().toISOString();
  const minutes = minutesBetween(e.started_at, end);
  if (minutes <= 0) throw new Error("Stop time must be after the start time");
  await query(`UPDATE time_entries SET ended_at = $3, minutes = $4 WHERE id = $1 AND user_id = $2 AND ended_at IS NULL`, [id, dataId, end, minutes]);
  const out = await getTimeEntry(dataId, id);
  if (!out) throw new Error("Time entry not found");
  return out;
}

export async function updateTimeEntry(dataId: string, id: string, patch: TimeEntryPatch): Promise<TimeEntryDTO> {
  const existing = await getTimeEntry(dataId, id);
  if (!existing) throw new Error("Time entry not found");
  if (existing.invoice_id && (patch.minutes !== undefined || patch.rate_minor !== undefined || patch.ended_at !== undefined || patch.started_at !== undefined)) {
    throw new Error("Duration and rate cannot change after the entry was invoiced");
  }
  const sets: string[] = [];
  const params: unknown[] = [id, dataId];
  const push = (col: string, v: unknown) => {
    params.push(v);
    sets.push(`${col} = $${params.length}`);
  };
  for (const key of ["member_id", "ref_kind", "ref_id", "description", "rate_minor", "currency", "billable"] as const) {
    if (patch[key] !== undefined) push(key, patch[key]);
  }
  const started_at = patch.started_at ?? existing.started_at;
  let ended_at = patch.ended_at === undefined ? existing.ended_at : patch.ended_at;
  let minutes = patch.minutes === undefined ? existing.minutes : patch.minutes;
  if (patch.started_at !== undefined || patch.ended_at !== undefined || patch.minutes !== undefined) {
    if (patch.minutes !== undefined) {
      ended_at = new Date(new Date(started_at).getTime() + patch.minutes * 60_000).toISOString();
      minutes = patch.minutes;
    } else if (ended_at) {
      minutes = minutesBetween(started_at, ended_at);
      if (minutes <= 0) throw new Error("ended_at must be after started_at");
    } else {
      minutes = null;
    }
    push("started_at", started_at);
    push("ended_at", ended_at);
    push("minutes", minutes);
  }
  if (sets.length === 0) return existing;
  await query(`UPDATE time_entries SET ${sets.join(", ")} WHERE id = $1 AND user_id = $2`, params);
  const out = await getTimeEntry(dataId, id);
  if (!out) throw new Error("Time entry not found");
  return out;
}

export async function deleteTimeEntry(dataId: string, id: string): Promise<boolean> {
  const existing = await getTimeEntry(dataId, id);
  if (!existing) return false;
  if (existing.invoice_id) throw new Error("Invoiced time entries cannot be deleted");
  await query(`DELETE FROM time_entries WHERE id = $1 AND user_id = $2`, [id, dataId]);
  return true;
}

export async function markTimeInvoiced(dataId: string, ids: string[], invoiceId: string): Promise<number> {
  if (ids.length === 0) return 0;
  const rows = await query<{ id: string }>(
    `UPDATE time_entries SET invoice_id = $3 WHERE user_id = $1 AND id = ANY($2::text[]) AND invoice_id IS NULL AND ended_at IS NOT NULL RETURNING id`,
    [dataId, ids, invoiceId]
  );
  return rows.length;
}
