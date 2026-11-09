import { randomUUID } from "crypto";
import { z } from "zod";
import { query, queryOne } from "@/lib/dsql";
import { emitEvent } from "@/lib/events/bus";
import { enqueueNotification } from "@/lib/notifications/outbox";
import { orgTimezone } from "@/lib/calendar/booking";
import { staffNames, WorkforceError } from "./staff";
import {
  addDays,
  bucketByDay,
  findShiftConflicts,
  isValidYmd,
  localMidnightUtc,
  SHIFT_STATUSES,
  shiftMinutes,
  weekDays,
  weekStartOf,
  type ShiftConflict,
  type ShiftDTO,
  type SwapDTO,
} from "./pure";

/**
 * Shifts (the rota). Drafts are invisible to staff; `publishShifts` flips
 * them to published, emits `shift.published` and notifies each assigned
 * person through the outbox. Conflicts (double booking, approved leave) are
 * rejected with a 409 that carries the details.
 */

export interface ShiftRow {
  id: string;
  user_id: string;
  staff_id: string | null;
  role_title: string | null;
  starts_at: string | Date;
  ends_at: string | Date;
  break_minutes: number;
  location: string | null;
  notes: string | null;
  status: string;
  published_at: string | Date | null;
  created_at: string | Date;
  updated_at: string | Date;
}

export const SHIFT_COLS = `id, user_id, staff_id, role_title, starts_at, ends_at, break_minutes, location, notes, status, published_at, created_at, updated_at`;

const iso = (v: string | Date) => new Date(v).toISOString();
const isoOrNull = (v: string | Date | null) => (v === null ? null : iso(v));

export function toShiftDTO(r: ShiftRow, names?: Map<string, string>): ShiftDTO {
  const starts_at = iso(r.starts_at);
  const ends_at = iso(r.ends_at);
  return {
    id: r.id,
    staff_id: r.staff_id,
    staff_name: r.staff_id ? names?.get(r.staff_id) ?? null : null,
    role_title: r.role_title,
    starts_at,
    ends_at,
    break_minutes: Number(r.break_minutes) || 0,
    minutes: shiftMinutes(starts_at, ends_at, Number(r.break_minutes) || 0),
    location: r.location,
    notes: r.notes,
    status: (SHIFT_STATUSES as readonly string[]).includes(r.status) ? (r.status as ShiftDTO["status"]) : "draft",
    published_at: isoOrNull(r.published_at),
    created_at: iso(r.created_at),
    updated_at: iso(r.updated_at),
  };
}

const Iso = z.string().datetime({ offset: true });

export const ShiftInputSchema = z
  .object({
    staff_id: z.string().trim().max(100).nullable().optional(),
    role_title: z.string().trim().max(80).nullable().optional(),
    starts_at: Iso,
    ends_at: Iso,
    break_minutes: z.number().int().min(0).max(600).default(0),
    location: z.string().trim().max(120).nullable().optional(),
    notes: z.string().trim().max(2000).nullable().optional(),
    /** Create directly as published (skips the draft step). */
    publish: z.boolean().optional(),
  })
  .strict();
export type ShiftInput = z.infer<typeof ShiftInputSchema>;
export const ShiftPatchSchema = ShiftInputSchema.omit({ publish: true }).partial().extend({ status: z.enum(SHIFT_STATUSES).optional() }).strict();
export type ShiftPatch = z.infer<typeof ShiftPatchSchema>;

function validateSpan(startsAt: string, endsAt: string, breakMinutes: number): void {
  const span = new Date(endsAt).getTime() - new Date(startsAt).getTime();
  if (!(span > 0)) throw new WorkforceError(400, "ends_at must be after starts_at");
  if (span > 24 * 3_600_000) throw new WorkforceError(400, "A shift cannot be longer than 24 hours");
  if (breakMinutes * 60_000 >= span) throw new WorkforceError(400, "break_minutes must be shorter than the shift");
}

async function assertStaff(dataId: string, staffId: string | null | undefined): Promise<void> {
  if (!staffId) return;
  const row = await queryOne<{ id: string }>(`SELECT id FROM staff_profiles WHERE user_id = $1 AND id = $2 AND active = TRUE`, [dataId, staffId]);
  if (!row) throw new WorkforceError(400, "staff_id is not an active staff profile");
}

/** Conflicts a candidate shift would have against the DB. Exported so the UI can warn before saving. */
export async function shiftConflicts(dataId: string, candidate: { id?: string | null; staff_id: string | null; starts_at: string; ends_at: string }): Promise<ShiftConflict[]> {
  if (!candidate.staff_id) return [];
  const tz = await orgTimezone(dataId);
  const dayPad = 2 * 86_400_000;
  const from = new Date(new Date(candidate.starts_at).getTime() - dayPad).toISOString();
  const to = new Date(new Date(candidate.ends_at).getTime() + dayPad).toISOString();
  const [shifts, leave] = await Promise.all([
    query<{ id: string; staff_id: string | null; starts_at: string | Date; ends_at: string | Date; status: string }>(
      `SELECT id, staff_id, starts_at, ends_at, status FROM shifts WHERE user_id = $1 AND staff_id = $2 AND status <> 'cancelled' AND ends_at > $3 AND starts_at < $4 LIMIT 200`,
      [dataId, candidate.staff_id, from, to]
    ),
    query<{ id: string; staff_id: string; starts_on: string; ends_on: string; status: string }>(
      `SELECT id, staff_id, starts_on::text AS starts_on, ends_on::text AS ends_on, status FROM leave_requests WHERE user_id = $1 AND staff_id = $2 AND status = 'approved' AND ends_on >= ($3::timestamptz)::date - 1 AND starts_on <= ($4::timestamptz)::date + 1 LIMIT 50`,
      [dataId, candidate.staff_id, from, to]
    ),
  ]);
  return findShiftConflicts(
    candidate,
    shifts.map((s) => ({ ...s, starts_at: iso(s.starts_at), ends_at: iso(s.ends_at) })),
    leave,
    tz
  );
}

function conflictError(conflicts: ShiftConflict[]): WorkforceError {
  return new WorkforceError(409, `Shift conflicts: ${conflicts.map((c) => c.message).join(" ")}`, { conflicts });
}

export async function getShift(dataId: string, id: string): Promise<ShiftDTO | null> {
  const row = await queryOne<ShiftRow>(`SELECT ${SHIFT_COLS} FROM shifts WHERE user_id = $1 AND id = $2`, [dataId, id]);
  if (!row) return null;
  return toShiftDTO(row, await staffNames(dataId, [row.staff_id]));
}

export interface ListShiftsOpts {
  from?: string | null;
  to?: string | null;
  staffId?: string | null;
  status?: string | null;
  includeCancelled?: boolean;
  limit?: number;
}

export async function listShifts(dataId: string, opts: ListShiftsOpts = {}): Promise<ShiftDTO[]> {
  const params: unknown[] = [dataId];
  const where = [`user_id = $1`];
  if (opts.from) {
    params.push(opts.from);
    where.push(`ends_at > $${params.length}`);
  }
  if (opts.to) {
    params.push(opts.to);
    where.push(`starts_at < $${params.length}`);
  }
  if (opts.staffId) {
    params.push(opts.staffId);
    where.push(`staff_id = $${params.length}`);
  }
  if (opts.status) {
    params.push(opts.status);
    where.push(`status = $${params.length}`);
  } else if (!opts.includeCancelled) where.push(`status <> 'cancelled'`);
  params.push(Math.min(Math.max(opts.limit ?? 500, 1), 2000));
  const rows = await query<ShiftRow>(`SELECT ${SHIFT_COLS} FROM shifts WHERE ${where.join(" AND ")} ORDER BY starts_at ASC, id ASC LIMIT $${params.length}`, params);
  const names = await staffNames(dataId, rows.map((r) => r.staff_id));
  return rows.map((r) => toShiftDTO(r, names));
}

export async function createShift(dataId: string, input: ShiftInput): Promise<ShiftDTO> {
  validateSpan(input.starts_at, input.ends_at, input.break_minutes);
  await assertStaff(dataId, input.staff_id);
  const conflicts = await shiftConflicts(dataId, { staff_id: input.staff_id ?? null, starts_at: input.starts_at, ends_at: input.ends_at });
  if (conflicts.length) throw conflictError(conflicts);
  const id = randomUUID();
  const status = input.publish ? "published" : "draft";
  await query(
    `INSERT INTO shifts (id, user_id, staff_id, role_title, starts_at, ends_at, break_minutes, location, notes, status, published_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, ${input.publish ? "NOW()" : "NULL"})`,
    [id, dataId, input.staff_id ?? null, input.role_title ?? null, input.starts_at, input.ends_at, input.break_minutes, input.location ?? null, input.notes ?? null, status]
  );
  const created = await getShift(dataId, id);
  if (!created) throw new WorkforceError(500, "shift not found after insert");
  if (input.publish) await notifyPublished(dataId, [created]);
  return created;
}

export async function updateShift(dataId: string, id: string, patch: ShiftPatch): Promise<ShiftDTO> {
  const existing = await getShift(dataId, id);
  if (!existing) throw new WorkforceError(404, "Shift not found");
  const next = { ...existing, ...patch };
  validateSpan(next.starts_at, next.ends_at, next.break_minutes);
  if (patch.staff_id !== undefined) await assertStaff(dataId, patch.staff_id);
  if (next.status !== "cancelled") {
    const conflicts = await shiftConflicts(dataId, { id, staff_id: next.staff_id ?? null, starts_at: next.starts_at, ends_at: next.ends_at });
    if (conflicts.length) throw conflictError(conflicts);
  }
  await query(
    `UPDATE shifts SET staff_id = $3, role_title = $4, starts_at = $5, ends_at = $6, break_minutes = $7, location = $8, notes = $9, status = $10, updated_at = NOW()
      WHERE user_id = $1 AND id = $2`,
    [dataId, id, next.staff_id ?? null, next.role_title ?? null, next.starts_at, next.ends_at, next.break_minutes, next.location ?? null, next.notes ?? null, next.status]
  );
  const updated = await getShift(dataId, id);
  if (!updated) throw new WorkforceError(404, "Shift not found");
  return updated;
}

/** Drafts are deleted outright; anything published is cancelled so staff see the change. */
export async function deleteShift(dataId: string, id: string): Promise<{ deleted: boolean; cancelled: boolean }> {
  const existing = await queryOne<{ status: string }>(`SELECT status FROM shifts WHERE user_id = $1 AND id = $2`, [dataId, id]);
  if (!existing) return { deleted: false, cancelled: false };
  if (existing.status === "draft") {
    await query(`DELETE FROM shifts WHERE user_id = $1 AND id = $2`, [dataId, id]);
    return { deleted: true, cancelled: false };
  }
  await query(`UPDATE shifts SET status = 'cancelled', updated_at = NOW() WHERE user_id = $1 AND id = $2`, [dataId, id]);
  return { deleted: false, cancelled: true };
}

async function notifyPublished(dataId: string, shifts: ShiftDTO[]): Promise<void> {
  const staffIds = [...new Set(shifts.map((s) => s.staff_id).filter((x): x is string => Boolean(x)))];
  const contacts = staffIds.length
    ? await query<{ id: string; display_name: string; email: string | null }>(`SELECT id, display_name, email FROM staff_profiles WHERE user_id = $1 AND id = ANY($2)`, [dataId, staffIds]).catch(() => [])
    : [];
  const byStaff = new Map(contacts.map((c) => [c.id, c]));
  const tz = await orgTimezone(dataId);
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  const tfmt = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" });
  for (const s of shifts) {
    await emitEvent(dataId, { type: "shift.published", entity: "shift", entityId: s.id, data: { staff_id: s.staff_id, starts_at: s.starts_at, ends_at: s.ends_at, role_title: s.role_title } });
  }
  for (const staffId of staffIds) {
    const c = byStaff.get(staffId);
    const mine = shifts.filter((s) => s.staff_id === staffId);
    if (!c || mine.length === 0) continue;
    const lines = mine.map((s) => `• ${fmt.format(new Date(s.starts_at))} – ${tfmt.format(new Date(s.ends_at))}${s.role_title ? ` (${s.role_title})` : ""}${s.location ? ` @ ${s.location}` : ""}`);
    const subject = mine.length === 1 ? "Your shift has been published" : `${mine.length} shifts published for you`;
    const body = `Hi ${c.display_name},\n\nYour schedule was published:\n${lines.join("\n")}\n\nTimes are shown in ${tz}.\n`;
    try {
      if (c.email) await enqueueNotification(dataId, { channel: "email", recipient: c.email, subject, body, data: { kind: "shift.published", staffId, shiftIds: mine.map((s) => s.id) } });
      await enqueueNotification(dataId, {
        channel: "in_app",
        recipient: dataId,
        subject: `Rota published: ${c.display_name}`,
        body: `${mine.length} shift${mine.length === 1 ? "" : "s"} published for ${c.display_name}.`,
        data: { kind: "shift.published", staffId, href: "/workforce" },
      });
    } catch (err) {
      console.error("[workforce] publish notification failed:", err);
    }
  }
}

/** Publish draft shifts by id. Returns the ids actually flipped (already-published ids are skipped). */
export async function publishShifts(dataId: string, ids: string[]): Promise<{ published: ShiftDTO[]; skipped: string[] }> {
  const unique = [...new Set(ids)].slice(0, 500);
  if (unique.length === 0) return { published: [], skipped: [] };
  const rows = await query<ShiftRow>(
    `UPDATE shifts SET status = 'published', published_at = NOW(), updated_at = NOW() WHERE user_id = $1 AND id = ANY($2) AND status = 'draft' RETURNING ${SHIFT_COLS}`,
    [dataId, unique]
  );
  const names = await staffNames(dataId, rows.map((r) => r.staff_id));
  const published = rows.map((r) => toShiftDTO(r, names));
  await notifyPublished(dataId, published);
  const done = new Set(published.map((s) => s.id));
  return { published, skipped: unique.filter((id) => !done.has(id)) };
}

/* ─── week view ────────────────────────────────────────────────────────── */

export interface WeekView {
  weekStart: string;
  days: string[];
  timezone: string;
  staff: Array<{ id: string; display_name: string; role_title: string | null; weekly_hours: number; active: boolean }>;
  shifts: ShiftDTO[];
  /** day → shifts starting that local day (incl. open shifts). */
  byDay: Record<string, ShiftDTO[]>;
  /** staff id → scheduled minutes this week. */
  minutesByStaff: Record<string, number>;
  openShifts: number;
  draftCount: number;
  pendingSwaps: number;
  /** Approved leave in the week, by staff id → set of local days. */
  leaveDays: Record<string, string[]>;
}

/** Normalise any Y-M-D (or missing value) to the Monday of its week; today's week by default. */
export function normaliseWeekStart(v: string | null | undefined, timezone = "UTC"): string {
  if (isValidYmd(v)) return weekStartOf(v);
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  return weekStartOf(today);
}

export async function weekView(dataId: string, weekStartParam?: string | null): Promise<WeekView> {
  const timezone = await orgTimezone(dataId);
  const weekStart = normaliseWeekStart(weekStartParam, timezone);
  const days = weekDays(weekStart);
  const from = localMidnightUtc(weekStart, timezone).toISOString();
  const to = localMidnightUtc(addDays(weekStart, 7), timezone).toISOString();
  const [staffRows, shifts, swaps, leave] = await Promise.all([
    query<{ id: string; display_name: string; role_title: string | null; weekly_hours: number; active: boolean }>(
      `SELECT id, display_name, role_title, weekly_hours, active FROM staff_profiles WHERE user_id = $1 AND active = TRUE ORDER BY display_name ASC LIMIT 500`,
      [dataId]
    ),
    listShifts(dataId, { from, to, limit: 2000 }),
    queryOne<{ n: string }>(`SELECT COUNT(*)::text AS n FROM shift_swaps WHERE user_id = $1 AND status = 'requested'`, [dataId]),
    query<{ staff_id: string; starts_on: string; ends_on: string }>(
      `SELECT staff_id, starts_on::text AS starts_on, ends_on::text AS ends_on FROM leave_requests WHERE user_id = $1 AND status = 'approved' AND ends_on >= $2 AND starts_on <= $3 LIMIT 500`,
      [dataId, weekStart, days[6]]
    ),
  ]);
  const byDay = bucketByDay(shifts, weekStart, timezone);
  const minutesByStaff: Record<string, number> = {};
  for (const s of shifts) if (s.staff_id && s.status !== "cancelled") minutesByStaff[s.staff_id] = (minutesByStaff[s.staff_id] ?? 0) + s.minutes;
  const leaveDays: Record<string, string[]> = {};
  for (const l of leave) {
    const set = new Set(leaveDays[l.staff_id] ?? []);
    for (const d of days) if (d >= l.starts_on && d <= l.ends_on) set.add(d);
    leaveDays[l.staff_id] = [...set];
  }
  return {
    weekStart,
    days,
    timezone,
    staff: staffRows.map((s) => ({ ...s, weekly_hours: Number(s.weekly_hours) || 0 })),
    shifts,
    byDay,
    minutesByStaff,
    openShifts: shifts.filter((s) => !s.staff_id && s.status !== "cancelled").length,
    draftCount: shifts.filter((s) => s.status === "draft").length,
    pendingSwaps: Number(swaps?.n ?? 0),
    leaveDays,
  };
}

/** Copy every non-cancelled shift of `sourceWeekStart` into `targetWeekStart` as drafts (7 days later by default). Conflicting copies are skipped. */
export async function copyWeek(dataId: string, sourceWeekStart: string, targetWeekStart?: string): Promise<{ created: number; skipped: number }> {
  const timezone = await orgTimezone(dataId);
  const src = normaliseWeekStart(sourceWeekStart, timezone);
  const dst = normaliseWeekStart(targetWeekStart ?? addDays(src, 7), timezone);
  const offsetMs = localMidnightUtc(dst, timezone).getTime() - localMidnightUtc(src, timezone).getTime();
  const from = localMidnightUtc(src, timezone).toISOString();
  const to = localMidnightUtc(addDays(src, 7), timezone).toISOString();
  const source = await listShifts(dataId, { from, to, limit: 2000 });
  let created = 0;
  let skipped = 0;
  for (const s of source) {
    const starts_at = new Date(new Date(s.starts_at).getTime() + offsetMs).toISOString();
    const ends_at = new Date(new Date(s.ends_at).getTime() + offsetMs).toISOString();
    try {
      await createShift(dataId, { staff_id: s.staff_id, role_title: s.role_title, starts_at, ends_at, break_minutes: s.break_minutes, location: s.location, notes: s.notes });
      created++;
    } catch (err) {
      if (err instanceof WorkforceError && (err.status === 409 || err.status === 400)) skipped++;
      else throw err;
    }
  }
  return { created, skipped };
}

/* ─── swaps ────────────────────────────────────────────────────────────── */

export interface SwapRow {
  id: string;
  user_id: string;
  shift_id: string;
  from_staff_id: string;
  to_staff_id: string;
  status: string;
  note: string | null;
  created_at: string | Date;
  decided_at: string | Date | null;
  shift_starts_at?: string | Date | null;
  shift_ends_at?: string | Date | null;
}

const SWAP_SELECT = `SELECT w.id, w.user_id, w.shift_id, w.from_staff_id, w.to_staff_id, w.status, w.note, w.created_at, w.decided_at, s.starts_at AS shift_starts_at, s.ends_at AS shift_ends_at
  FROM shift_swaps w LEFT JOIN shifts s ON s.id = w.shift_id AND s.user_id = w.user_id`;

function toSwapDTO(r: SwapRow, names: Map<string, string>): SwapDTO {
  return {
    id: r.id,
    shift_id: r.shift_id,
    from_staff_id: r.from_staff_id,
    to_staff_id: r.to_staff_id,
    from_staff_name: names.get(r.from_staff_id) ?? null,
    to_staff_name: names.get(r.to_staff_id) ?? null,
    status: r.status === "approved" || r.status === "rejected" ? r.status : "requested",
    note: r.note,
    created_at: iso(r.created_at),
    decided_at: isoOrNull(r.decided_at),
    shift_starts_at: r.shift_starts_at ? iso(r.shift_starts_at) : null,
    shift_ends_at: r.shift_ends_at ? iso(r.shift_ends_at) : null,
  };
}

export async function listSwaps(dataId: string, opts: { status?: string | null; limit?: number } = {}): Promise<SwapDTO[]> {
  const params: unknown[] = [dataId];
  let where = `w.user_id = $1`;
  if (opts.status) {
    params.push(opts.status);
    where += ` AND w.status = $${params.length}`;
  }
  params.push(Math.min(Math.max(opts.limit ?? 200, 1), 500));
  const rows = await query<SwapRow>(`${SWAP_SELECT} WHERE ${where} ORDER BY w.created_at DESC LIMIT $${params.length}`, params);
  const names = await staffNames(dataId, rows.flatMap((r) => [r.from_staff_id, r.to_staff_id]));
  return rows.map((r) => toSwapDTO(r, names));
}

export const SwapRequestSchema = z.object({ to_staff_id: z.string().trim().min(1).max(100), note: z.string().trim().max(1000).nullable().optional() }).strict();

export async function requestSwap(dataId: string, shiftId: string, input: z.infer<typeof SwapRequestSchema>): Promise<SwapDTO> {
  const shift = await getShift(dataId, shiftId);
  if (!shift) throw new WorkforceError(404, "Shift not found");
  if (!shift.staff_id) throw new WorkforceError(400, "An open shift has nobody to swap from — assign it instead");
  if (shift.status === "cancelled") throw new WorkforceError(400, "Cannot swap a cancelled shift");
  if (shift.staff_id === input.to_staff_id) throw new WorkforceError(400, "Pick a different colleague");
  await assertStaff(dataId, input.to_staff_id);
  const open = await queryOne<{ id: string }>(`SELECT id FROM shift_swaps WHERE user_id = $1 AND shift_id = $2 AND status = 'requested'`, [dataId, shiftId]);
  if (open) throw new WorkforceError(409, "A swap is already pending for this shift", { swap_id: open.id });
  const conflicts = await shiftConflicts(dataId, { id: shiftId, staff_id: input.to_staff_id, starts_at: shift.starts_at, ends_at: shift.ends_at });
  if (conflicts.length) throw conflictError(conflicts);
  const id = randomUUID();
  await query(`INSERT INTO shift_swaps (id, user_id, shift_id, from_staff_id, to_staff_id, status, note) VALUES ($1, $2, $3, $4, $5, 'requested', $6)`, [id, dataId, shiftId, shift.staff_id, input.to_staff_id, input.note ?? null]);
  await emitEvent(dataId, { type: "shift.swap_requested", entity: "shift_swap", entityId: id, data: { shift_id: shiftId, from_staff_id: shift.staff_id, to_staff_id: input.to_staff_id } });
  await enqueueNotification(dataId, {
    channel: "in_app",
    recipient: dataId,
    subject: "Shift swap requested",
    body: `A swap was requested for the shift on ${shift.starts_at.slice(0, 10)}.`,
    data: { kind: "shift.swap_requested", swapId: id, href: "/workforce?tab=rota" },
  }).catch(() => undefined);
  const row = await queryOne<SwapRow>(`${SWAP_SELECT} WHERE w.user_id = $1 AND w.id = $2`, [dataId, id]);
  if (!row) throw new WorkforceError(500, "swap not found after insert");
  return toSwapDTO(row, await staffNames(dataId, [row.from_staff_id, row.to_staff_id]));
}

export const SwapDecisionSchema = z.object({ decision: z.enum(["approve", "reject"]) }).strict();

/** Approve (re-assigns the shift and marks it swapped) or reject. Race-safe: the status flip is conditional on `requested`. */
export async function decideSwap(dataId: string, swapId: string, decision: "approve" | "reject"): Promise<SwapDTO> {
  const current = await queryOne<SwapRow>(`${SWAP_SELECT} WHERE w.user_id = $1 AND w.id = $2`, [dataId, swapId]);
  if (!current) throw new WorkforceError(404, "Swap not found");
  if (current.status !== "requested") throw new WorkforceError(409, `Swap already ${current.status}`);
  if (decision === "approve") {
    const shift = await getShift(dataId, current.shift_id);
    if (!shift || shift.status === "cancelled") throw new WorkforceError(409, "The shift no longer exists");
    const conflicts = await shiftConflicts(dataId, { id: shift.id, staff_id: current.to_staff_id, starts_at: shift.starts_at, ends_at: shift.ends_at });
    if (conflicts.length) throw conflictError(conflicts);
  }
  const flipped = await query<{ id: string }>(
    `UPDATE shift_swaps SET status = $3, decided_at = NOW() WHERE user_id = $1 AND id = $2 AND status = 'requested' RETURNING id`,
    [dataId, swapId, decision === "approve" ? "approved" : "rejected"]
  );
  if (flipped.length === 0) throw new WorkforceError(409, "Swap was decided concurrently");
  if (decision === "approve") {
    await query(`UPDATE shifts SET staff_id = $3, status = CASE WHEN status = 'draft' THEN 'draft' ELSE 'swapped' END, updated_at = NOW() WHERE user_id = $1 AND id = $2`, [dataId, current.shift_id, current.to_staff_id]);
  }
  const row = await queryOne<SwapRow>(`${SWAP_SELECT} WHERE w.user_id = $1 AND w.id = $2`, [dataId, swapId]);
  if (!row) throw new WorkforceError(404, "Swap not found");
  return toSwapDTO(row, await staffNames(dataId, [row.from_staff_id, row.to_staff_id]));
}

/* ─── capacity adapter ─────────────────────────────────────────────────── */

/**
 * Published shifts as capacity supply for src/lib/optimize/capacity.ts:
 * `{ member_id, starts_at, ends_at, minutes }` for each non-cancelled shift
 * in the window. Pass as `shifts` in CapacityInputs to replace the
 * availability-rule estimate with the real rota.
 */
export async function capacityInput(dataId: string, from: string, to: string): Promise<Array<{ id: string; member_id: string | null; starts_at: string; ends_at: string; minutes: number }>> {
  const shifts = await listShifts(dataId, { from, to, limit: 5000 }).catch(() => []);
  return shifts.filter((s) => s.status !== "draft").map((s) => ({ id: s.id, member_id: s.staff_id, starts_at: s.starts_at, ends_at: s.ends_at, minutes: s.minutes }));
}
