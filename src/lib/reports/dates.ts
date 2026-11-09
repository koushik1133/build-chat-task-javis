import type { DatePreset } from "./spec";

/**
 * Relative date ranges resolved in an IANA time zone. Pure; used by the
 * compiler (filters) and tested with fixed `now` instants.
 */

interface Parts { y: number; m: number; d: number; h: number; mi: number; s: number; wd: number }

function zonedParts(date: Date, timeZone: string): Parts | null {
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", weekday: "short" }).formatToParts(date);
    const get = (t: Intl.DateTimeFormatPart["type"]) => parts.find((p) => p.type === t)?.value ?? "";
    const wd = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(get("weekday"));
    return { y: Number(get("year")), m: Number(get("month")) - 1, d: Number(get("day")), h: Number(get("hour")), mi: Number(get("minute")), s: Number(get("second")), wd: wd < 0 ? 0 : wd };
  } catch {
    return null;
  }
}

/** Instant of local midnight on (y, m, d) in `timeZone`; m/d may overflow like Date.UTC. */
export function zonedMidnight(y: number, m: number, d: number, timeZone: string): Date {
  return zonedTime(y, m, d, 0, 0, timeZone);
}

/**
 * Instant of local wall time (y, m, d, h, mi) in `timeZone`. Resolved by
 * iteration so DST changes between midnight and `h` do not shift the hour
 * (midnight + h*3600000 would be off by one on transition days). A wall time
 * inside a spring-forward gap resolves to the instant after the gap.
 */
export function zonedTime(y: number, m: number, d: number, h: number, mi: number, timeZone: string): Date {
  const guess = Date.UTC(y, m, d, h, mi);
  let instant = guess;
  for (let i = 0; i < 3; i++) {
    const p = zonedParts(new Date(instant), timeZone);
    if (!p) return new Date(guess);
    const wallAsUtc = Date.UTC(p.y, p.m, p.d, p.h, p.mi, p.s);
    if (wallAsUtc === guess) break;
    instant = guess - (wallAsUtc - instant);
  }
  return new Date(instant);
}

export function isValidZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** [start, end) for a preset, in the org's calendar. */
export function resolvePreset(preset: DatePreset, now: Date, timeZone: string): { from: Date; to: Date } {
  const tz = isValidZone(timeZone) ? timeZone : "UTC";
  const p = zonedParts(now, tz) ?? { y: now.getUTCFullYear(), m: now.getUTCMonth(), d: now.getUTCDate(), h: 0, mi: 0, s: 0, wd: now.getUTCDay() };
  const day = (offset: number) => zonedMidnight(p.y, p.m, p.d + offset, tz);
  const weekStart = (offset: number) => zonedMidnight(p.y, p.m, p.d - ((p.wd + 6) % 7) + offset * 7, tz); // Monday-based
  const q = Math.floor(p.m / 3) * 3;
  switch (preset) {
    case "today": return { from: day(0), to: day(1) };
    case "yesterday": return { from: day(-1), to: day(0) };
    case "last_7_days": return { from: day(-6), to: day(1) };
    case "last_30_days": return { from: day(-29), to: day(1) };
    case "last_90_days": return { from: day(-89), to: day(1) };
    case "this_week": return { from: weekStart(0), to: weekStart(1) };
    case "last_week": return { from: weekStart(-1), to: weekStart(0) };
    case "this_month": return { from: zonedMidnight(p.y, p.m, 1, tz), to: zonedMidnight(p.y, p.m + 1, 1, tz) };
    case "last_month": return { from: zonedMidnight(p.y, p.m - 1, 1, tz), to: zonedMidnight(p.y, p.m, 1, tz) };
    case "this_quarter": return { from: zonedMidnight(p.y, q, 1, tz), to: zonedMidnight(p.y, q + 3, 1, tz) };
    case "this_year": return { from: zonedMidnight(p.y, 0, 1, tz), to: zonedMidnight(p.y + 1, 0, 1, tz) };
    case "last_year": return { from: zonedMidnight(p.y - 1, 0, 1, tz), to: zonedMidnight(p.y, 0, 1, tz) };
  }
}

/** Parse an ISO instant or YYYY-MM-DD (as local midnight in tz). */
export function parseDateInput(v: string | null | undefined, timeZone: string, endOfDay = false): Date | null {
  if (!v) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (m) {
    const d = zonedMidnight(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + (endOfDay ? 1 : 0), isValidZone(timeZone) ? timeZone : "UTC");
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Human label for a preset. */
export function presetLabel(preset: DatePreset): string {
  return preset.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}
