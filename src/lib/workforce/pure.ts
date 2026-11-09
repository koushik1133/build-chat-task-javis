/**
 * Workforce — pure, client-safe helpers (no DB imports).
 *
 * Shared by the server libs, the agent tools and the /workforce page:
 * shift arithmetic, conflict detection, week bucketing in a timezone,
 * leave-balance math and payroll lines.
 */

export const EMPLOYMENT_TYPES = ["full_time", "part_time", "contractor"] as const;
export type EmploymentType = (typeof EMPLOYMENT_TYPES)[number];

export const SHIFT_STATUSES = ["draft", "published", "confirmed", "swapped", "cancelled"] as const;
export type ShiftStatus = (typeof SHIFT_STATUSES)[number];

export const SWAP_STATUSES = ["requested", "approved", "rejected"] as const;
export type SwapStatus = (typeof SWAP_STATUSES)[number];

export const LEAVE_KINDS = ["vacation", "sick", "unpaid", "other"] as const;
export type LeaveKind = (typeof LEAVE_KINDS)[number];

export const LEAVE_STATUSES = ["pending", "approved", "rejected", "cancelled"] as const;
export type LeaveStatus = (typeof LEAVE_STATUSES)[number];

export const ATTENDANCE_SOURCES = ["crew", "manual", "shift"] as const;
export type AttendanceSource = (typeof ATTENDANCE_SOURCES)[number];

/** Leave kinds that are paid at the hourly rate in the payroll export. */
export const PAID_LEAVE_KINDS: readonly LeaveKind[] = ["vacation", "sick"];

export interface StaffDTO {
  id: string;
  membership_id: string | null;
  display_name: string;
  email: string | null;
  phone: string | null;
  role_title: string | null;
  employment_type: EmploymentType;
  hourly_rate_minor: number;
  currency: string;
  weekly_hours: number;
  skills: string[];
  location: string | null;
  start_date: string | null;
  end_date: string | null;
  active: boolean;
  created_at: string;
  updated_at: string;
}

export interface ShiftDTO {
  id: string;
  staff_id: string | null;
  staff_name: string | null;
  role_title: string | null;
  starts_at: string;
  ends_at: string;
  break_minutes: number;
  /** Paid minutes: span minus break. */
  minutes: number;
  location: string | null;
  notes: string | null;
  status: ShiftStatus;
  published_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface SwapDTO {
  id: string;
  shift_id: string;
  from_staff_id: string;
  to_staff_id: string;
  from_staff_name: string | null;
  to_staff_name: string | null;
  status: SwapStatus;
  note: string | null;
  created_at: string;
  decided_at: string | null;
  shift_starts_at: string | null;
  shift_ends_at: string | null;
}

export interface LeaveDTO {
  id: string;
  staff_id: string;
  staff_name: string | null;
  kind: LeaveKind;
  starts_on: string;
  ends_on: string;
  hours: number;
  status: LeaveStatus;
  note: string | null;
  decided_by: string | null;
  decided_at: string | null;
  created_at: string;
}

export interface BalanceDTO {
  staff_id: string;
  staff_name: string | null;
  kind: LeaveKind;
  year: number;
  allotted_hours: number;
  used_hours: number;
  remaining_hours: number;
}

export interface AttendanceDTO {
  id: string;
  staff_id: string;
  staff_name: string | null;
  shift_id: string | null;
  clock_in: string;
  clock_out: string | null;
  source: AttendanceSource;
  minutes: number | null;
  /** Scheduled minutes of the linked shift (null when unlinked). */
  scheduled_minutes: number | null;
  /** attended − scheduled, null when either side is unknown. */
  variance_minutes: number | null;
  created_at: string;
}

/* ─── time helpers ─────────────────────────────────────────────────────── */

const DAY_MS = 86_400_000;

/** Whole paid minutes of a shift: span minus break, never negative. */
export function shiftMinutes(startsAt: string, endsAt: string, breakMinutes = 0): number {
  const ms = new Date(endsAt).getTime() - new Date(startsAt).getTime();
  if (!Number.isFinite(ms) || ms <= 0) return 0;
  return Math.max(0, Math.round(ms / 60_000) - Math.max(0, Math.round(breakMinutes)));
}

/** Whole minutes between a clock-in and a clock-out, 0 for inverted or open pairs. */
export function attendanceMinutes(clockIn: string, clockOut: string | null | undefined): number | null {
  if (!clockOut) return null;
  const ms = new Date(clockOut).getTime() - new Date(clockIn).getTime();
  if (!Number.isFinite(ms) || ms <= 0) return 0;
  return Math.round(ms / 60_000);
}

export function intervalsOverlap(aStart: string, aEnd: string, bStart: string, bEnd: string): boolean {
  const as = new Date(aStart).getTime();
  const ae = new Date(aEnd).getTime();
  const bs = new Date(bStart).getTime();
  const be = new Date(bEnd).getTime();
  return as < be && bs < ae;
}

/** Y-M-D of an instant in a timezone. */
export function localDate(iso: string | Date, timezone: string): string {
  const d = typeof iso === "string" ? new Date(iso) : iso;
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" });
  return fmt.format(d);
}

/** Monday (YYYY-MM-DD) of the week containing `ymd`. Pure calendar math — no timezone needed once the date is local. */
export function weekStartOf(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const dow = (dt.getUTCDay() + 6) % 7; // Monday = 0
  dt.setUTCDate(dt.getUTCDate() - dow);
  return dt.toISOString().slice(0, 10);
}

export function addDays(ymd: string, days: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d) + days * DAY_MS).toISOString().slice(0, 10);
}

/** The seven Y-M-D strings of a week starting at `weekStart`. */
export function weekDays(weekStart: string): string[] {
  return Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
}

/** Local day-of-week (0 = Sunday) for a Y-M-D string. */
export function dayOfWeek(ymd: string): number {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export function isValidYmd(v: unknown): v is string {
  return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));
}

/** UTC instant of local midnight for `ymd` in `timezone` (iterative offset fix handles DST). */
export function localMidnightUtc(ymd: string, timezone: string): Date {
  const [y, m, d] = ymd.split("-").map(Number);
  const target = Date.UTC(y, m - 1, d);
  let guess = target;
  for (let i = 0; i < 3; i++) {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" })
        .formatToParts(new Date(guess))
        .map((p) => [p.type, p.value])
    );
    const wall = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
    const diff = wall - target;
    if (diff === 0) break;
    guess -= diff;
  }
  return new Date(guess);
}

/** Group items by the local day their `starts_at` falls on, for the seven days of a week. Items outside the week are dropped. */
export function bucketByDay<T extends { starts_at: string }>(items: T[], weekStart: string, timezone: string): Record<string, T[]> {
  const out: Record<string, T[]> = {};
  for (const day of weekDays(weekStart)) out[day] = [];
  for (const it of items) {
    const day = localDate(it.starts_at, timezone);
    if (day in out) out[day].push(it);
  }
  for (const day of Object.keys(out)) out[day].sort((a, b) => a.starts_at.localeCompare(b.starts_at));
  return out;
}

/* ─── conflicts ────────────────────────────────────────────────────────── */

export interface ShiftConflict {
  kind: "shift_overlap" | "on_leave";
  shift_id?: string;
  leave_id?: string;
  message: string;
}

export interface ConflictCandidate {
  id?: string | null;
  staff_id: string | null;
  starts_at: string;
  ends_at: string;
}

export interface ConflictShift {
  id: string;
  staff_id: string | null;
  starts_at: string;
  ends_at: string;
  status: string;
}

export interface ConflictLeave {
  id: string;
  staff_id: string;
  starts_on: string;
  ends_on: string;
  status: string;
}

/**
 * Conflicts for one candidate shift: another live shift for the same person
 * that overlaps in time, or approved leave covering any local day the shift
 * touches. Open (unassigned) shifts never conflict.
 */
export function findShiftConflicts(candidate: ConflictCandidate, shifts: ConflictShift[], leave: ConflictLeave[], timezone = "UTC"): ShiftConflict[] {
  if (!candidate.staff_id) return [];
  const out: ShiftConflict[] = [];
  for (const s of shifts) {
    if (s.id === candidate.id || s.staff_id !== candidate.staff_id || s.status === "cancelled") continue;
    if (intervalsOverlap(candidate.starts_at, candidate.ends_at, s.starts_at, s.ends_at)) {
      out.push({ kind: "shift_overlap", shift_id: s.id, message: `Overlaps another shift (${s.starts_at.slice(11, 16)}–${s.ends_at.slice(11, 16)} UTC).` });
    }
  }
  const startDay = localDate(candidate.starts_at, timezone);
  const endDay = localDate(new Date(new Date(candidate.ends_at).getTime() - 1), timezone);
  for (const l of leave) {
    if (l.staff_id !== candidate.staff_id || l.status !== "approved") continue;
    if (l.starts_on <= endDay && l.ends_on >= startDay) {
      out.push({ kind: "on_leave", leave_id: l.id, message: `On approved leave ${l.starts_on}${l.ends_on !== l.starts_on ? ` to ${l.ends_on}` : ""}.` });
    }
  }
  return out;
}

/* ─── leave ────────────────────────────────────────────────────────────── */

/** Number of Monday–Friday days in an inclusive Y-M-D range. */
export function weekdaysBetween(startsOn: string, endsOn: string): number {
  if (endsOn < startsOn) return 0;
  let n = 0;
  for (let d = startsOn; d <= endsOn; d = addDays(d, 1)) {
    const dow = dayOfWeek(d);
    if (dow !== 0 && dow !== 6) n++;
    if (n > 400) break;
  }
  return n;
}

/** Default hours for a leave request: weekdays × (weekly hours ÷ 5), rounded to whole hours, at least 1 when the range is non-empty. */
export function defaultLeaveHours(startsOn: string, endsOn: string, weeklyHours: number): number {
  const days = weekdaysBetween(startsOn, endsOn);
  if (days === 0) return 0;
  return Math.max(1, Math.round((days * Math.max(0, weeklyHours)) / 5));
}

export function remainingHours(b: { allotted_hours: number; used_hours: number }): number {
  return Math.max(0, Number(b.allotted_hours) - Number(b.used_hours));
}

/* ─── payroll ──────────────────────────────────────────────────────────── */

export interface PayrollInput {
  staff: Pick<StaffDTO, "id" | "display_name" | "role_title" | "employment_type" | "hourly_rate_minor" | "currency" | "weekly_hours">;
  scheduledMinutes: number;
  attendedMinutes: number;
  /** Approved paid leave hours in the period. */
  paidLeaveHours: number;
  /** Approved unpaid/other leave hours (reported, not paid). */
  unpaidLeaveHours: number;
  /** Length of the period in weeks (fractional allowed). */
  periodWeeks: number;
}

export interface PayrollLine {
  staff_id: string;
  display_name: string;
  role_title: string | null;
  employment_type: EmploymentType;
  currency: string;
  hourly_rate_minor: number;
  weekly_hours: number;
  scheduled_hours: number;
  attended_hours: number;
  paid_leave_hours: number;
  unpaid_leave_hours: number;
  regular_hours: number;
  overtime_hours: number;
  /** attended − scheduled, in hours (negative = under). */
  variance_hours: number;
  gross_minor: number;
}

export const OVERTIME_MULTIPLIER = 1.5;

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * One payroll line. Hours paid = attended hours + paid leave. Overtime is
 * anything above weekly_hours × weeks of *attended* time (contractors never
 * accrue overtime), paid at 1.5×.
 */
export function payrollLine(input: PayrollInput): PayrollLine {
  const attended = input.attendedMinutes / 60;
  const scheduled = input.scheduledMinutes / 60;
  const threshold = input.staff.employment_type === "contractor" ? Number.POSITIVE_INFINITY : Math.max(0, input.staff.weekly_hours) * Math.max(0, input.periodWeeks);
  const overtime = Math.max(0, attended - threshold);
  const regular = attended - overtime;
  const rate = Number(input.staff.hourly_rate_minor) || 0;
  const gross = Math.floor((regular + input.paidLeaveHours) * rate + overtime * rate * OVERTIME_MULTIPLIER + 0.5);
  return {
    staff_id: input.staff.id,
    display_name: input.staff.display_name,
    role_title: input.staff.role_title,
    employment_type: input.staff.employment_type,
    currency: input.staff.currency,
    hourly_rate_minor: rate,
    weekly_hours: input.staff.weekly_hours,
    scheduled_hours: round2(scheduled),
    attended_hours: round2(attended),
    paid_leave_hours: round2(input.paidLeaveHours),
    unpaid_leave_hours: round2(input.unpaidLeaveHours),
    regular_hours: round2(regular),
    overtime_hours: round2(overtime),
    variance_hours: round2(attended - scheduled),
    gross_minor: gross,
  };
}

/** Weeks in an inclusive Y-M-D range (days ÷ 7, fractional). */
export function periodWeeks(from: string, to: string): number {
  const days = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS) + 1;
  return Math.max(0, days) / 7;
}

export function parseSkills(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, 50) : [];
  } catch {
    return [];
  }
}
