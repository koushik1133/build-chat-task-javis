/** Recurring-invoice cadence math (pure, client-safe). */

export type ScheduleInterval = "weekly" | "monthly" | "quarterly" | "yearly";
export const SCHEDULE_INTERVALS: readonly ScheduleInterval[] = ["weekly", "monthly", "quarterly", "yearly"];

function daysInMonth(yearUtc: number, monthUtc: number): number {
  return new Date(Date.UTC(yearUtc, monthUtc + 1, 0)).getUTCDate();
}

/**
 * Next run strictly after `from`. Month-based intervals keep the configured
 * `dayOfMonth` (or the anchor's day) and clamp to the month's last day, so a
 * schedule anchored on Jan 31 runs Feb 28/29, Mar 31, Apr 30 … (UTC).
 */
export function advanceNextRun(from: Date, interval: ScheduleInterval, intervalCount = 1, dayOfMonth: number | null = null): Date {
  const n = Math.max(1, Math.floor(intervalCount));
  if (interval === "weekly") return new Date(from.getTime() + n * 7 * 86_400_000);
  const months = interval === "monthly" ? n : interval === "quarterly" ? n * 3 : n * 12;
  const y = from.getUTCFullYear();
  const m = from.getUTCMonth() + months;
  const wantDay = dayOfMonth && dayOfMonth >= 1 && dayOfMonth <= 31 ? dayOfMonth : from.getUTCDate();
  const targetY = y + Math.floor(m / 12);
  const targetM = ((m % 12) + 12) % 12;
  const day = Math.min(wantDay, daysInMonth(targetY, targetM));
  return new Date(Date.UTC(targetY, targetM, day, from.getUTCHours(), from.getUTCMinutes(), from.getUTCSeconds()));
}

/** Preview the next `count` run instants from `start` (first entry is `start` itself when in the future). */
export function previewRuns(start: Date, interval: ScheduleInterval, intervalCount: number, dayOfMonth: number | null, count = 3, endAt: Date | null = null): Date[] {
  const out: Date[] = [];
  let cur = start;
  for (let i = 0; i < count; i++) {
    if (endAt && cur.getTime() > endAt.getTime()) break;
    out.push(cur);
    cur = advanceNextRun(cur, interval, intervalCount, dayOfMonth);
  }
  return out;
}
