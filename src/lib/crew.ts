import { randomUUID } from "crypto";
import { query, queryOne } from "@/lib/dsql";
import { resolveShareToken, type ShareTokenRow } from "@/lib/share-tokens";
import { tableExists } from "@/lib/table-exists";
import { minutesBetween } from "@/lib/finance/time";
import { clockInStaff, clockOutStaff, openAttendance } from "@/lib/workforce/attendance";
import { requestLeave } from "@/lib/workforce/leave";
import { WorkforceError } from "@/lib/workforce/staff";
import { LEAVE_KINDS, type LeaveKind } from "@/lib/workforce/pure";

/** Crew clock-ins are ordinary time_entries rows keyed by ref_kind/ref_id = crew/<token id>. */
export const CREW_REF_KIND = "crew";

/**
 * Crew mode: what a field worker sees and can do through a `crew` share
 * token (no account). Everything is scoped to the token's workspace.
 */

export interface CrewTask {
  id: string;
  title: string;
  done: boolean;
  created_at: string;
}

/** Booking as shown to field crew. The customer's email is deliberately not included: crew only needs a name and a number to call. */
export interface CrewBooking {
  id: string;
  name: string;
  phone: string | null;
  starts_at: string;
  ends_at: string;
  status: string;
  notes: string | null;
}

/** A published shift as shown to the person it belongs to. */
export interface CrewShift {
  id: string;
  starts_at: string;
  ends_at: string;
  role_title: string | null;
  location: string | null;
  status: string;
}

export interface CrewDay {
  workspace: string;
  label: string;
  timezone: string;
  date: string; // YYYY-MM-DD in timezone
  tasks: CrewTask[];
  bookings: CrewBooking[];
  openTickets: number | null;
  timeTracking: boolean;
  clockedInAt: string | null;
  /** Set when the crew link is tied to a staff profile (Workforce → Staff → crew link). */
  staff: { id: string; name: string } | null;
  /** Next 14 days of published shifts for the linked staff member. */
  upcomingShifts: CrewShift[];
  /** Pending leave requests for the linked staff member. */
  pendingLeave: number;
}

export function isValidTimeZone(tz: string | null | undefined): tz is string {
  if (!tz || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Y-M-D of `now` in `tz`, plus the UTC instants of that local day's start/end. */
export function dayRangeInTz(tz: string, now = new Date()): { date: string; start: Date; end: Date } {
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
  const parts = Object.fromEntries(fmt.formatToParts(now).map((p) => [p.type, p.value]));
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  // Offset = (wall clock interpreted as UTC) − actual instant.
  const wall = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  const offsetMs = wall - Math.floor(now.getTime() / 1000) * 1000;
  const start = new Date(Date.UTC(+parts.year, +parts.month - 1, +parts.day) - offsetMs);
  const end = new Date(start.getTime() + 86_400_000);
  return { date, start, end };
}

export type CrewToken = ShareTokenRow & { label: string | null; staff_id: string | null };

export async function resolveCrewToken(token: string): Promise<CrewToken | null> {
  const row = await resolveShareToken("crew", token);
  if (!row) return null;
  const extra = await queryOne<{ label: string | null; staff_id: string | null }>(`SELECT label, staff_id FROM share_tokens WHERE id = $1`, [row.id]).catch(
    async () => (await queryOne<{ label: string | null }>(`SELECT label FROM share_tokens WHERE id = $1`, [row.id]).catch(() => null)) as { label: string | null; staff_id?: string | null } | null
  );
  return { ...row, label: extra?.label ?? null, staff_id: extra?.staff_id ?? null };
}

async function defaultTimezone(dataId: string): Promise<string> {
  const cal = await queryOne<{ timezone: string }>(`SELECT timezone FROM calendars WHERE user_id = $1 ORDER BY created_at ASC LIMIT 1`, [dataId]).catch(() => null);
  return isValidTimeZone(cal?.timezone) ? cal.timezone : "UTC";
}

export async function getCrewDay(t: CrewToken, tzParam?: string | null): Promise<CrewDay> {
  const dataId = t.user_id;
  const timezone = isValidTimeZone(tzParam) ? tzParam : await defaultTimezone(dataId);
  const { date, start, end } = dayRangeInTz(timezone);

  const [org, tasks, bookings, hasTickets, hasTime] = await Promise.all([
    queryOne<{ name: string }>(`SELECT name FROM organizations WHERE id = $1`, [t.entity_id]).catch(() => null),
    query<CrewTask>(
      `SELECT id, title, done, created_at FROM tasks WHERE user_id = $1 AND deleted_at IS NULL AND (done = FALSE OR created_at >= $2)
        ORDER BY done ASC, created_at DESC LIMIT 100`,
      [dataId, start.toISOString()]
    ).catch(() => [] as CrewTask[]),
    query<CrewBooking>(
      `SELECT id, name, phone, starts_at, ends_at, status, notes FROM bookings
        WHERE user_id = $1 AND starts_at >= $2 AND starts_at < $3 AND status <> 'cancelled' ORDER BY starts_at ASC LIMIT 100`,
      [dataId, start.toISOString(), end.toISOString()]
    ).catch(() => [] as CrewBooking[]),
    tableExists("tickets"),
    tableExists("time_entries"),
  ]);

  let openTickets: number | null = null;
  if (hasTickets) {
    const row = await queryOne<{ n: string }>(`SELECT COUNT(*)::text AS n FROM tickets WHERE user_id = $1 AND status IN ('open','pending')`, [dataId]).catch(() => null);
    openTickets = row ? Number(row.n) : null;
  }

  let clockedInAt: string | null = null;
  if (hasTime) {
    const open = await queryOne<{ started_at: string }>(
      `SELECT started_at FROM time_entries WHERE user_id = $1 AND ref_kind = $2 AND ref_id = $3 AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1`,
      [dataId, CREW_REF_KIND, t.id]
    ).catch(() => null);
    clockedInAt = open?.started_at ? new Date(open.started_at).toISOString() : null;
  }

  // Workforce self-service: the person's own published shifts and leave, when the link is tied to a staff profile.
  let staff: CrewDay["staff"] = null;
  let upcomingShifts: CrewShift[] = [];
  let pendingLeave = 0;
  if (t.staff_id) {
    const [profile, shifts, leave, openAtt] = await Promise.all([
      queryOne<{ id: string; display_name: string }>(`SELECT id, display_name FROM staff_profiles WHERE user_id = $1 AND id = $2 AND active = TRUE`, [dataId, t.staff_id]).catch(() => null),
      query<CrewShift>(
        `SELECT id, starts_at, ends_at, role_title, location, status FROM shifts WHERE user_id = $1 AND staff_id = $2 AND status IN ('published','confirmed','swapped') AND ends_at >= $3 AND starts_at < $4 ORDER BY starts_at ASC LIMIT 50`,
        [dataId, t.staff_id, start.toISOString(), new Date(start.getTime() + 14 * 86_400_000).toISOString()]
      ).catch(() => [] as CrewShift[]),
      queryOne<{ n: string }>(`SELECT COUNT(*)::text AS n FROM leave_requests WHERE user_id = $1 AND staff_id = $2 AND status = 'pending'`, [dataId, t.staff_id]).catch(() => null),
      openAttendance(dataId, t.staff_id).catch(() => null),
    ]);
    if (profile) {
      staff = { id: profile.id, name: profile.display_name };
      upcomingShifts = shifts.map((s) => ({ ...s, starts_at: new Date(s.starts_at).toISOString(), ends_at: new Date(s.ends_at).toISOString() }));
      pendingLeave = Number(leave?.n ?? 0);
      if (!clockedInAt && openAtt) clockedInAt = openAtt.clock_in;
    }
  }

  return {
    workspace: org?.name ?? "Workspace",
    label: t.label ?? "Crew",
    timezone,
    date,
    tasks: tasks.map((r) => ({ ...r, created_at: new Date(r.created_at).toISOString() })),
    bookings: bookings.map((b) => ({ ...b, starts_at: new Date(b.starts_at).toISOString(), ends_at: new Date(b.ends_at).toISOString() })),
    openTickets,
    timeTracking: hasTime || Boolean(staff),
    clockedInAt,
    staff,
    upcomingShifts,
    pendingLeave,
  };
}

export type CrewAction =
  | { action: "complete_task"; taskId: string; done?: boolean }
  | { action: "add_note"; note: string; bookingId?: string | null }
  | { action: "clock_in" }
  | { action: "clock_out" }
  | { action: "request_leave"; kind: LeaveKind; starts_on: string; ends_on: string; note?: string | null };

export class CrewActionError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = "CrewActionError";
  }
}

export async function runCrewAction(t: CrewToken, a: CrewAction): Promise<Record<string, unknown>> {
  const dataId = t.user_id;
  const who = t.label ?? "Crew";
  switch (a.action) {
    case "complete_task": {
      const rows = await query<{ id: string; done: boolean }>(
        `UPDATE tasks SET done = $3 WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL RETURNING id, done`,
        [a.taskId, dataId, a.done ?? true]
      );
      if (!rows[0]) throw new CrewActionError(404, "Task not found.");
      return { task: rows[0] };
    }
    case "add_note": {
      const note = a.note.trim().slice(0, 2000);
      if (!note) throw new CrewActionError(400, "Note is empty.");
      const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
      if (a.bookingId) {
        const rows = await query<{ id: string }>(
          `UPDATE bookings SET notes = CONCAT(COALESCE(notes, ''), CASE WHEN notes IS NULL OR notes = '' THEN '' ELSE E'\n' END, $3), updated_at = NOW()
            WHERE id = $1 AND user_id = $2 RETURNING id`,
          [a.bookingId, dataId, `[${stamp} ${who}] ${note}`]
        );
        if (!rows[0]) throw new CrewActionError(404, "Booking not found.");
      }
      // Surface it to the workspace owner in the notification bell.
      await query(`INSERT INTO notifications (user_id, title, body) VALUES ($1, $2, $3)`, [dataId, `Crew note from ${who}`, note]).catch((err) =>
        console.warn("[crew] could not notify owner:", err instanceof Error ? err.message : err)
      );
      return { ok: true };
    }
    case "request_leave": {
      if (!t.staff_id) throw new CrewActionError(403, "This link is not tied to a staff profile.");
      if (!LEAVE_KINDS.includes(a.kind)) throw new CrewActionError(400, "Unknown leave kind.");
      try {
        const leave = await requestLeave(dataId, { staff_id: t.staff_id, kind: a.kind, starts_on: a.starts_on, ends_on: a.ends_on, note: a.note ?? null }, `crew:${t.id}`);
        return { leave };
      } catch (err) {
        if (err instanceof WorkforceError) throw new CrewActionError(err.status, err.message);
        throw err;
      }
    }
    case "clock_in":
    case "clock_out": {
      const hasTime = await tableExists("time_entries");
      if (!hasTime && !t.staff_id) throw new CrewActionError(501, "Time tracking is not enabled for this workspace.");
      // Attendance (workforce) when the link is tied to a staff profile; time_entries keeps the billing/job-costing trail.
      if (t.staff_id) {
        const att = a.action === "clock_in" ? await clockInStaff(dataId, t.staff_id, "crew").catch(() => null) : await clockOutStaff(dataId, t.staff_id).catch(() => null);
        if (!att && !hasTime) throw new CrewActionError(409, a.action === "clock_in" ? "Already clocked in." : "Not clocked in.");
        if (att && !hasTime) return a.action === "clock_in" ? { attendanceId: att.id, startedAt: att.clock_in } : { attendanceId: att.id, startedAt: att.clock_in, endedAt: att.clock_out };
      }
      try {
        if (a.action === "clock_in") {
          // Conditional INSERT: one open crew timer per token, decided inside the statement.
          const id = randomUUID();
          const startedAt = new Date().toISOString();
          const inserted = await query<{ id: string }>(
            `INSERT INTO time_entries (id, user_id, member_id, ref_kind, ref_id, description, started_at, rate_minor, currency, billable)
             SELECT $1, $2, NULL, $3, $4, $5, $6, 0, 'USD', FALSE
              WHERE NOT EXISTS (SELECT 1 FROM time_entries WHERE user_id = $2 AND ref_kind = $3 AND ref_id = $4 AND ended_at IS NULL)
             RETURNING id`,
            [id, dataId, CREW_REF_KIND, t.id, `Crew: ${who}`, startedAt]
          );
          if (inserted.length && t.staff_id) await query(`UPDATE time_entries SET staff_id = $3 WHERE id = $1 AND user_id = $2`, [id, dataId, t.staff_id]).catch(() => undefined);
          if (inserted.length === 0) throw new CrewActionError(409, "Already clocked in.");
          return { entryId: id, startedAt };
        }
        const rows = await query<{ id: string; started_at: string | Date; ended_at: string | Date }>(
          `UPDATE time_entries SET ended_at = NOW() WHERE user_id = $1 AND ref_kind = $2 AND ref_id = $3 AND ended_at IS NULL RETURNING id, started_at, ended_at`,
          [dataId, CREW_REF_KIND, t.id]
        );
        if (!rows[0]) throw new CrewActionError(409, "Not clocked in.");
        const startedAt = new Date(rows[0].started_at).toISOString();
        const endedAt = new Date(rows[0].ended_at).toISOString();
        // Fill `minutes` so the entry shows up in billables / job costing like any other stopped timer.
        await query(`UPDATE time_entries SET minutes = $3 WHERE id = $1 AND user_id = $2`, [rows[0].id, dataId, minutesBetween(startedAt, endedAt)]).catch(() => undefined);
        return { entryId: rows[0].id, startedAt, endedAt };
      } catch (err) {
        if (err instanceof CrewActionError) throw err;
        console.warn("[crew] time_entries write failed:", err instanceof Error ? err.message : err);
        throw new CrewActionError(501, "Time tracking is not available right now.");
      }
    }
    default:
      throw new CrewActionError(400, "Unsupported action.");
  }
}
