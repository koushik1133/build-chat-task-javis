import { randomUUID } from "crypto";
import { z } from "zod";
import { query, queryOne } from "@/lib/dsql";
import { staffNames, WorkforceError } from "./staff";
import { attendanceMinutes, ATTENDANCE_SOURCES, shiftMinutes, type AttendanceDTO } from "./pure";

/**
 * Attendance: actual clock in/out per staff member. Crew links write here
 * (src/lib/crew.ts) when the token is linked to a staff profile; managers can
 * add manual rows. Each row is matched to the shift it overlaps (if any) so
 * the UI can show scheduled vs actual.
 */

export interface AttendanceRow {
  id: string;
  user_id: string;
  staff_id: string;
  shift_id: string | null;
  clock_in: string | Date;
  clock_out: string | Date | null;
  source: string;
  minutes: number | null;
  created_at: string | Date;
  shift_starts_at?: string | Date | null;
  shift_ends_at?: string | Date | null;
  shift_break?: number | null;
}

const SELECT = `SELECT a.id, a.user_id, a.staff_id, a.shift_id, a.clock_in, a.clock_out, a.source, a.minutes, a.created_at, s.starts_at AS shift_starts_at, s.ends_at AS shift_ends_at, s.break_minutes AS shift_break
  FROM attendance a LEFT JOIN shifts s ON s.id = a.shift_id AND s.user_id = a.user_id`;

const iso = (v: string | Date) => new Date(v).toISOString();

export function toAttendanceDTO(r: AttendanceRow, names?: Map<string, string>): AttendanceDTO {
  const clock_in = iso(r.clock_in);
  const clock_out = r.clock_out ? iso(r.clock_out) : null;
  const minutes = r.minutes === null || r.minutes === undefined ? attendanceMinutes(clock_in, clock_out) : Number(r.minutes);
  const scheduled = r.shift_starts_at && r.shift_ends_at ? shiftMinutes(iso(r.shift_starts_at), iso(r.shift_ends_at), Number(r.shift_break) || 0) : null;
  return {
    id: r.id,
    staff_id: r.staff_id,
    staff_name: names?.get(r.staff_id) ?? null,
    shift_id: r.shift_id,
    clock_in,
    clock_out,
    source: (ATTENDANCE_SOURCES as readonly string[]).includes(r.source) ? (r.source as AttendanceDTO["source"]) : "manual",
    minutes,
    scheduled_minutes: scheduled,
    variance_minutes: minutes !== null && scheduled !== null ? minutes - scheduled : null,
    created_at: iso(r.created_at),
  };
}

const Iso = z.string().datetime({ offset: true });

export const AttendanceInputSchema = z
  .object({
    staff_id: z.string().trim().min(1).max(100),
    shift_id: z.string().trim().max(100).nullable().optional(),
    clock_in: Iso,
    clock_out: Iso.nullable().optional(),
  })
  .strict();
export type AttendanceInput = z.infer<typeof AttendanceInputSchema>;

/** The shift this person is scheduled for around `at` (±2h tolerance), or null. */
export async function matchShift(dataId: string, staffId: string, at: string): Promise<string | null> {
  const row = await queryOne<{ id: string }>(
    `SELECT id FROM shifts WHERE user_id = $1 AND staff_id = $2 AND status <> 'cancelled' AND starts_at <= ($3::timestamptz + INTERVAL '2 hours') AND ends_at >= ($3::timestamptz - INTERVAL '2 hours')
      ORDER BY ABS(EXTRACT(EPOCH FROM (starts_at - $3::timestamptz))) ASC LIMIT 1`,
    [dataId, staffId, at]
  ).catch(() => null);
  return row?.id ?? null;
}

export async function listAttendance(dataId: string, opts: { from?: string | null; to?: string | null; staffId?: string | null; limit?: number } = {}): Promise<AttendanceDTO[]> {
  const params: unknown[] = [dataId];
  const where = [`a.user_id = $1`];
  if (opts.from) {
    params.push(opts.from);
    where.push(`a.clock_in >= $${params.length}`);
  }
  if (opts.to) {
    params.push(opts.to);
    where.push(`a.clock_in < $${params.length}`);
  }
  if (opts.staffId) {
    params.push(opts.staffId);
    where.push(`a.staff_id = $${params.length}`);
  }
  params.push(Math.min(Math.max(opts.limit ?? 500, 1), 5000));
  const rows = await query<AttendanceRow>(`${SELECT} WHERE ${where.join(" AND ")} ORDER BY a.clock_in DESC LIMIT $${params.length}`, params);
  const names = await staffNames(dataId, rows.map((r) => r.staff_id));
  return rows.map((r) => toAttendanceDTO(r, names));
}

export async function createAttendance(dataId: string, input: AttendanceInput, source: AttendanceDTO["source"] = "manual"): Promise<AttendanceDTO> {
  const staff = await queryOne<{ id: string }>(`SELECT id FROM staff_profiles WHERE user_id = $1 AND id = $2`, [dataId, input.staff_id]);
  if (!staff) throw new WorkforceError(400, "staff_id is not a staff profile");
  if (input.clock_out && new Date(input.clock_out).getTime() <= new Date(input.clock_in).getTime()) throw new WorkforceError(400, "clock_out must be after clock_in");
  const shiftId = input.shift_id === undefined ? await matchShift(dataId, input.staff_id, input.clock_in) : input.shift_id;
  const id = randomUUID();
  await query(`INSERT INTO attendance (id, user_id, staff_id, shift_id, clock_in, clock_out, source, minutes) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`, [
    id,
    dataId,
    input.staff_id,
    shiftId ?? null,
    input.clock_in,
    input.clock_out ?? null,
    source,
    attendanceMinutes(input.clock_in, input.clock_out ?? null),
  ]);
  const row = await queryOne<AttendanceRow>(`${SELECT} WHERE a.user_id = $1 AND a.id = $2`, [dataId, id]);
  if (!row) throw new WorkforceError(500, "attendance not found after insert");
  return toAttendanceDTO(row, await staffNames(dataId, [row.staff_id]));
}

/** Open (not clocked out) attendance row for a staff member, or null. */
export async function openAttendance(dataId: string, staffId: string): Promise<AttendanceDTO | null> {
  const row = await queryOne<AttendanceRow>(`${SELECT} WHERE a.user_id = $1 AND a.staff_id = $2 AND a.clock_out IS NULL ORDER BY a.clock_in DESC LIMIT 1`, [dataId, staffId]);
  return row ? toAttendanceDTO(row) : null;
}

/** Crew clock-in: one open row per staff member, decided inside the INSERT. Returns null when already clocked in. */
export async function clockInStaff(dataId: string, staffId: string, source: AttendanceDTO["source"] = "crew"): Promise<AttendanceDTO | null> {
  const id = randomUUID();
  const now = new Date().toISOString();
  const shiftId = await matchShift(dataId, staffId, now);
  const rows = await query<{ id: string }>(
    `INSERT INTO attendance (id, user_id, staff_id, shift_id, clock_in, clock_out, source, minutes)
     SELECT $1, $2, $3, $4, $5, NULL, $6, NULL WHERE NOT EXISTS (SELECT 1 FROM attendance WHERE user_id = $2 AND staff_id = $3 AND clock_out IS NULL) RETURNING id`,
    [id, dataId, staffId, shiftId, now, source]
  );
  if (rows.length === 0) return null;
  const row = await queryOne<AttendanceRow>(`${SELECT} WHERE a.user_id = $1 AND a.id = $2`, [dataId, id]);
  return row ? toAttendanceDTO(row) : null;
}

/** Crew clock-out: closes the open row and fills minutes. Returns null when nothing was open. */
export async function clockOutStaff(dataId: string, staffId: string): Promise<AttendanceDTO | null> {
  const rows = await query<{ id: string; clock_in: string | Date; clock_out: string | Date }>(
    `UPDATE attendance SET clock_out = NOW() WHERE user_id = $1 AND staff_id = $2 AND clock_out IS NULL RETURNING id, clock_in, clock_out`,
    [dataId, staffId]
  );
  if (!rows[0]) return null;
  const minutes = attendanceMinutes(iso(rows[0].clock_in), iso(rows[0].clock_out));
  await query(`UPDATE attendance SET minutes = $3 WHERE user_id = $1 AND id = $2`, [dataId, rows[0].id, minutes]);
  const row = await queryOne<AttendanceRow>(`${SELECT} WHERE a.user_id = $1 AND a.id = $2`, [dataId, rows[0].id]);
  return row ? toAttendanceDTO(row) : null;
}

/** Attended minutes per staff id in [from, to) (closed rows only). */
export async function attendedMinutesByStaff(dataId: string, from: string, to: string): Promise<Map<string, number>> {
  const rows = await query<{ staff_id: string; n: string }>(
    `SELECT staff_id, COALESCE(SUM(minutes), 0)::text AS n FROM attendance WHERE user_id = $1 AND clock_in >= $2 AND clock_in < $3 AND clock_out IS NOT NULL GROUP BY staff_id`,
    [dataId, from, to]
  );
  return new Map(rows.map((r) => [r.staff_id, Number(r.n)]));
}
