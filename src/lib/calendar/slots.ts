/**
 * Pure slot arithmetic for the booking calendar. No DB, no I/O.
 *
 * Availability rules are expressed as minutes-from-midnight on a weekday in
 * the calendar's IANA timezone. Everything else (bookings, blocks, `now`) is
 * an absolute instant. The timezone mapping goes through `Intl` so DST is
 * handled by the platform, not by hand-rolled offsets.
 */

export interface Interval {
  start: Date;
  end: Date;
}

export interface AvailabilityRule {
  weekday: number; // 0 = Sunday … 6 = Saturday
  start_minute: number;
  end_minute: number;
}

export interface SlotType {
  duration_minutes: number;
  buffer_before: number;
  buffer_after: number;
  min_notice_minutes: number;
  max_days_ahead: number;
}

export interface Buffers {
  before: number;
  after: number;
}

export interface ListSlotsInput {
  rules: AvailabilityRule[];
  existing: Interval[];
  blocks: Interval[];
  /** External calendar busy windows (synced from Google/Outlook). Optional so callers stay pure. */
  busy?: Interval[];
  type: SlotType;
  from: Date;
  to: Date;
  now: Date;
  timezone: string;
  /** Step between candidate slot starts, in minutes. Defaults to the duration. */
  stepMinutes?: number;
}

const MS_PER_MIN = 60_000;
const MS_PER_DAY = 86_400_000;

/**
 * True when `candidate` (padded by buffers) overlaps any existing interval.
 * Buffers extend the candidate: `before` minutes ahead of the start and
 * `after` minutes past the end must also be free.
 */
export function wouldClash(candidate: Interval, existing: Interval[], buffers: Buffers = { before: 0, after: 0 }): boolean {
  const start = candidate.start.getTime() - Math.max(0, buffers.before) * MS_PER_MIN;
  const end = candidate.end.getTime() + Math.max(0, buffers.after) * MS_PER_MIN;
  if (end <= start) return true;
  for (const e of existing) {
    const es = e.start.getTime();
    const ee = e.end.getTime();
    if (es < end && ee > start) return true;
  }
  return false;
}

/* ---------- timezone helpers ---------- */

const fmtCache = new Map<string, Intl.DateTimeFormat>();

function formatter(timezone: string): Intl.DateTimeFormat {
  let f = fmtCache.get(timezone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      weekday: "short",
    });
    fmtCache.set(timezone, f);
  }
  return f;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export interface ZonedParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number; // 0-6
}

/** Break an instant into wall-clock parts in `timezone`. */
export function zonedParts(date: Date, timezone: string): ZonedParts {
  const parts = formatter(timezone).formatToParts(date);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "0";
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    hour: Number(get("hour")) % 24,
    minute: Number(get("minute")),
    second: Number(get("second")),
    weekday: Math.max(0, WEEKDAYS.indexOf(get("weekday"))),
  };
}

/** Offset (ms) of `timezone` from UTC at `date`: local = utc + offset. */
function tzOffsetMs(date: Date, timezone: string): number {
  const p = zonedParts(date, timezone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/**
 * Convert wall-clock (y, m, d, minuteOfDay) in `timezone` to an instant.
 * Uses a two-pass offset fix so DST transition days resolve correctly.
 */
export function zonedToUtc(year: number, month: number, day: number, minuteOfDay: number, timezone: string): Date {
  const wall = Date.UTC(year, month - 1, day, 0, 0, 0) + minuteOfDay * MS_PER_MIN;
  let guess = wall - tzOffsetMs(new Date(wall), timezone);
  const off2 = tzOffsetMs(new Date(guess), timezone);
  guess = wall - off2;
  return new Date(guess);
}

/** Calendar date (in timezone) for an instant, as y/m/d. */
function localDate(date: Date, timezone: string): { year: number; month: number; day: number; weekday: number } {
  const p = zonedParts(date, timezone);
  return { year: p.year, month: p.month, day: p.day, weekday: p.weekday };
}

function addDays(y: number, m: number, d: number, n: number): { year: number; month: number; day: number } {
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return { year: t.getUTCFullYear(), month: t.getUTCMonth() + 1, day: t.getUTCDate() };
}

/* ---------- listSlots ---------- */

/**
 * Enumerate bookable slot starts (ISO strings) between `from` and `to`.
 *
 * Honours: weekday rules (in calendar tz), duration, buffers, min notice,
 * max days ahead, existing bookings and blocks.
 */
export function listSlots(input: ListSlotsInput): string[] {
  const { rules, existing, blocks, type, timezone, now } = input;
  const duration = Math.max(1, Math.floor(type.duration_minutes));
  const step = Math.max(5, Math.floor(input.stepMinutes ?? duration));
  const buffers: Buffers = { before: type.buffer_before ?? 0, after: type.buffer_after ?? 0 };

  const earliest = Math.max(input.from.getTime(), now.getTime() + Math.max(0, type.min_notice_minutes) * MS_PER_MIN);
  const horizon = now.getTime() + Math.max(0, type.max_days_ahead) * MS_PER_DAY;
  const latestEnd = Math.min(input.to.getTime(), horizon);
  if (earliest >= latestEnd) return [];

  const busy: Interval[] = [...existing, ...blocks, ...(input.busy ?? [])];
  const out: string[] = [];
  const seen = new Set<number>();

  // Walk each calendar day (in tz) that touches the window, one day of slack
  // on each side so a window that starts late at night in UTC still covers
  // the local day that is already in progress.
  const startDay = localDate(new Date(earliest), timezone);
  const endDay = localDate(new Date(latestEnd), timezone);
  const dayCount =
    Math.round((Date.UTC(endDay.year, endDay.month - 1, endDay.day) - Date.UTC(startDay.year, startDay.month - 1, startDay.day)) / MS_PER_DAY) + 1;

  for (let i = -1; i <= dayCount; i++) {
    const d = addDays(startDay.year, startDay.month, startDay.day, i);
    const midnight = zonedToUtc(d.year, d.month, d.day, 0, timezone);
    const weekday = zonedParts(midnight, timezone).weekday;
    const dayRules = rules.filter((r) => r.weekday === weekday && r.end_minute > r.start_minute);
    for (const r of dayRules) {
      for (let m = r.start_minute; m + duration <= r.end_minute; m += step) {
        const start = zonedToUtc(d.year, d.month, d.day, m, timezone);
        const s = start.getTime();
        const e = s + duration * MS_PER_MIN;
        if (s < earliest || e > latestEnd) continue;
        if (seen.has(s)) continue;
        // The slot itself must sit inside the rule window even across DST
        // (zonedToUtc keeps wall-clock minutes, so the check is by minutes).
        if (wouldClash({ start, end: new Date(e) }, busy, buffers)) continue;
        seen.add(s);
        out.push(start.toISOString());
      }
    }
  }

  out.sort();
  return out;
}

/** Group ISO slots by local date (YYYY-MM-DD) in `timezone`. */
export function groupSlotsByDay(slots: string[], timezone: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const iso of slots) {
    const p = zonedParts(new Date(iso), timezone);
    const key = `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
    (out[key] ??= []).push(iso);
  }
  return out;
}
