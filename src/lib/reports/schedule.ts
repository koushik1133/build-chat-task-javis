import { zonedTime } from "./dates";

/** Pure schedule maths for report schedules and digests (next run in the org time zone). */

export type Cadence = "daily" | "weekly" | "monthly";
export const CADENCES: readonly Cadence[] = ["daily", "weekly", "monthly"];

export interface CadenceSpec {
  cadence: Cadence;
  /** 0-23 local hour. */
  hour: number;
  /** 0 (Sunday) - 6; weekly only. */
  weekday?: number | null;
  /** 1-28; monthly only. */
  dayOfMonth?: number | null;
}

function localParts(d: Date, tz: string): { y: number; m: number; d: number; wd: number } {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", weekday: "short" }).formatToParts(d);
  const get = (t: Intl.DateTimeFormatPart["type"]) => parts.find((p) => p.type === t)?.value ?? "";
  return { y: Number(get("year")), m: Number(get("month")) - 1, d: Number(get("day")), wd: Math.max(0, ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(get("weekday"))) };
}

function safeZone(tz: string): string {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    return "UTC";
  }
}

/** First instant strictly after `after` matching the cadence at `hour` local time. */
export function nextRunAt(spec: CadenceSpec, after: Date, timeZone: string): Date {
  const tz = safeZone(timeZone);
  const hour = Math.max(0, Math.min(23, Math.floor(spec.hour)));
  const p = localParts(after, tz);
  const at = (y: number, m: number, d: number) => zonedTime(y, m, d, hour, 0, tz);
  for (let i = 0; i < 400; i++) {
    const cand = at(p.y, p.m, p.d + i);
    if (cand.getTime() <= after.getTime()) continue;
    const lp = localParts(cand, tz);
    if (spec.cadence === "weekly" && lp.wd !== ((spec.weekday ?? 1) % 7)) continue;
    if (spec.cadence === "monthly" && lp.d !== Math.max(1, Math.min(28, spec.dayOfMonth ?? 1))) continue;
    return cand;
  }
  return at(p.y, p.m, p.d + 1);
}

/** Whether `now` falls inside quiet hours (local wall clock; ranges may wrap midnight). */
export function inQuietHours(quiet: { start?: string | null; end?: string | null } | null | undefined, now: Date, timeZone: string): boolean {
  if (!quiet?.start || !quiet.end) return false;
  const toMin = (s: string) => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(s);
    return m ? Math.min(23, Number(m[1])) * 60 + Math.min(59, Number(m[2])) : null;
  };
  const start = toMin(quiet.start);
  const end = toMin(quiet.end);
  if (start === null || end === null || start === end) return false;
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: safeZone(timeZone), hourCycle: "h23", hour: "2-digit", minute: "2-digit" }).formatToParts(now);
  const get = (t: Intl.DateTimeFormatPart["type"]) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const cur = get("hour") * 60 + get("minute");
  return start < end ? cur >= start && cur < end : cur >= start || cur < end;
}

/** Next instant quiet hours end (used to defer a notification). */
export function quietHoursEnd(quiet: { start?: string | null; end?: string | null }, now: Date, timeZone: string): Date {
  const m = /^(\d{1,2}):(\d{2})$/.exec(quiet.end ?? "");
  if (!m) return now;
  const tz = safeZone(timeZone);
  const p = localParts(now, tz);
  const endMin = Math.min(23, Number(m[1])) * 60 + Math.min(59, Number(m[2]));
  for (let i = 0; i < 2; i++) {
    const cand = zonedTime(p.y, p.m, p.d + i, Math.floor(endMin / 60), endMin % 60, tz);
    if (cand.getTime() > now.getTime()) return cand;
  }
  return now;
}
