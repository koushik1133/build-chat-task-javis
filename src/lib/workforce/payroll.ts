import { query } from "@/lib/dsql";
import { toCsv } from "@/lib/export/csv";
import { orgTimezone } from "@/lib/calendar/booking";
import { approvedLeaveHours } from "./leave";
import { attendedMinutesByStaffAndWeek } from "./attendance";
import { listStaff, WorkforceError } from "./staff";
import { addDays, isValidYmd, localMidnightUtc, payrollLine, periodWeeks, type PayrollLine } from "./pure";

/**
 * Payroll export: per staff member for an inclusive Y-M-D range — scheduled
 * hours (non-cancelled shifts), attended hours (closed attendance), approved
 * leave split paid/unpaid, overtime above weekly_hours per calendar week (org
 * timezone) and gross pay at the hourly rate (overtime at 1.5×). Both JSON and CSV.
 */

export interface PayrollExport {
  from: string;
  to: string;
  timezone: string;
  weeks: number;
  lines: PayrollLine[];
  totals: { scheduled_hours: number; attended_hours: number; overtime_hours: number; paid_leave_hours: number; gross_by_currency: Record<string, number> };
}

export async function payrollExport(dataId: string, range: { from: string; to: string }): Promise<PayrollExport> {
  if (!isValidYmd(range.from) || !isValidYmd(range.to)) throw new WorkforceError(400, "from/to must be YYYY-MM-DD");
  if (range.to < range.from) throw new WorkforceError(400, "to must not be before from");
  const weeks = periodWeeks(range.from, range.to);
  if (weeks > 53) throw new WorkforceError(400, "Range is limited to one year");
  const timezone = await orgTimezone(dataId);
  const fromIso = localMidnightUtc(range.from, timezone).toISOString();
  const toIso = localMidnightUtc(addDays(range.to, 1), timezone).toISOString();

  const [staff, scheduledRows, attended, leave] = await Promise.all([
    listStaff(dataId, { includeInactive: true }),
    query<{ staff_id: string; starts_at: string | Date; ends_at: string | Date; break_minutes: number }>(
      `SELECT staff_id, starts_at, ends_at, break_minutes FROM shifts WHERE user_id = $1 AND staff_id IS NOT NULL AND status <> 'cancelled' AND starts_at >= $2 AND starts_at < $3 LIMIT 20000`,
      [dataId, fromIso, toIso]
    ),
    attendedMinutesByStaffAndWeek(dataId, fromIso, toIso, timezone),
    approvedLeaveHours(dataId, range.from, range.to),
  ]);
  const scheduled = new Map<string, number>();
  for (const s of scheduledRows) {
    const span = Math.max(0, Math.round((new Date(s.ends_at).getTime() - new Date(s.starts_at).getTime()) / 60_000) - (Number(s.break_minutes) || 0));
    scheduled.set(s.staff_id, (scheduled.get(s.staff_id) ?? 0) + span);
  }
  const lines = staff
    .filter((s) => s.active || scheduled.has(s.id) || attended.has(s.id) || leave.has(s.id))
    .map((s) =>
      payrollLine({
        staff: s,
        scheduledMinutes: scheduled.get(s.id) ?? 0,
        attendedMinutes: Object.values(attended.get(s.id) ?? {}).reduce((a, b) => a + b, 0),
        attendedMinutesByWeek: attended.get(s.id) ?? {},
        paidLeaveHours: leave.get(s.id)?.paid ?? 0,
        unpaidLeaveHours: leave.get(s.id)?.unpaid ?? 0,
        periodWeeks: weeks,
      })
    );
  const totals = { scheduled_hours: 0, attended_hours: 0, overtime_hours: 0, paid_leave_hours: 0, gross_by_currency: {} as Record<string, number> };
  for (const l of lines) {
    totals.scheduled_hours += l.scheduled_hours;
    totals.attended_hours += l.attended_hours;
    totals.overtime_hours += l.overtime_hours;
    totals.paid_leave_hours += l.paid_leave_hours;
    totals.gross_by_currency[l.currency] = (totals.gross_by_currency[l.currency] ?? 0) + l.gross_minor;
  }
  const r2 = (n: number) => Math.round(n * 100) / 100;
  totals.scheduled_hours = r2(totals.scheduled_hours);
  totals.attended_hours = r2(totals.attended_hours);
  totals.overtime_hours = r2(totals.overtime_hours);
  totals.paid_leave_hours = r2(totals.paid_leave_hours);
  return { from: range.from, to: range.to, timezone, weeks: r2(weeks), lines, totals };
}

export const PAYROLL_CSV_COLUMNS = [
  { key: "staff_id", label: "Staff ID" },
  { key: "display_name", label: "Name" },
  { key: "role_title", label: "Role" },
  { key: "employment_type", label: "Employment" },
  { key: "currency", label: "Currency" },
  { key: "hourly_rate", label: "Hourly rate" },
  { key: "weekly_hours", label: "Weekly hours" },
  { key: "scheduled_hours", label: "Scheduled hours" },
  { key: "attended_hours", label: "Attended hours" },
  { key: "variance_hours", label: "Variance hours" },
  { key: "paid_leave_hours", label: "Paid leave hours" },
  { key: "unpaid_leave_hours", label: "Unpaid leave hours" },
  { key: "regular_hours", label: "Regular hours" },
  { key: "overtime_hours", label: "Overtime hours" },
  { key: "gross", label: "Gross pay" },
];

export function payrollCsv(exp: PayrollExport): string {
  const rows = exp.lines.map((l) => ({
    ...l,
    hourly_rate: (l.hourly_rate_minor / 100).toFixed(2),
    gross: (l.gross_minor / 100).toFixed(2),
  }));
  return toCsv(rows, PAYROLL_CSV_COLUMNS, { bom: true });
}
