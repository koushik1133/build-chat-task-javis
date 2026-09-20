/**
 * Minimal 5-field cron matcher (minute hour day-of-month month day-of-week)
 * with timezone support and no dependencies.
 *
 * Supports: `*`, lists `1,2,3`, ranges `1-5`, steps `*\/15` and `1-30/5`,
 * and the aliases `@hourly`, `@daily`, `@weekly`, `@monthly`. Day-of-week is
 * 0–6 (Sunday = 0; 7 also means Sunday).
 */

const ALIASES: Record<string, string> = {
  "@hourly": "0 * * * *",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@weekly": "0 0 * * 0",
  "@monthly": "0 0 1 * *",
};

const RANGES: [number, number][] = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 7],
];

type Field = Set<number>;

function parseField(text: string, min: number, max: number): Field | null {
  const out = new Set<number>();
  for (const part of text.split(",")) {
    const m = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part.trim());
    if (!m) return null;
    let lo = min;
    let hi = max;
    if (m[1] !== "*") {
      const [a, b] = m[1].split("-").map(Number);
      lo = a;
      hi = b ?? a;
    }
    const step = m[2] ? Number(m[2]) : 1;
    if (lo < min || hi > max || lo > hi || step < 1) return null;
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

export interface ParsedCron {
  minute: Field;
  hour: Field;
  dayOfMonth: Field;
  month: Field;
  dayOfWeek: Field;
}

export function parseCron(expr: string): ParsedCron | null {
  const text = (ALIASES[expr.trim()] ?? expr).trim().split(/\s+/);
  if (text.length !== 5) return null;
  const fields = text.map((t, i) => parseField(t, RANGES[i][0], RANGES[i][1]));
  if (fields.some((f) => f === null)) return null;
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields as Field[];
  if (dayOfWeek.has(7)) dayOfWeek.add(0);
  return { minute, hour, dayOfMonth, month, dayOfWeek };
}

export function isValidCron(expr: string): boolean {
  return parseCron(expr) !== null;
}

/** Wall-clock components of `date` in `timeZone`. */
function partsIn(date: Date, timeZone: string) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    weekday: "short",
  });
  const p: Record<string, string> = {};
  for (const { type, value } of fmt.formatToParts(date)) p[type] = value;
  const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return {
    minute: Number(p.minute),
    hour: Number(p.hour) % 24,
    day: Number(p.day),
    month: Number(p.month),
    weekday: weekdays.indexOf(p.weekday),
  };
}

/** True when the expression fires at the minute containing `date` in `timeZone`. */
export function cronMatches(expr: string | ParsedCron, date: Date, timeZone = "UTC"): boolean {
  const c = typeof expr === "string" ? parseCron(expr) : expr;
  if (!c) return false;
  const t = partsIn(date, timeZone);
  return (
    c.minute.has(t.minute) &&
    c.hour.has(t.hour) &&
    c.dayOfMonth.has(t.day) &&
    c.month.has(t.month) &&
    c.dayOfWeek.has(t.weekday)
  );
}

/**
 * Next firing time strictly after `from`, scanning minute by minute for up to
 * ~1 year. Returns null for expressions that can never fire (e.g. Feb 30).
 */
export function nextRun(expr: string | ParsedCron, from: Date, timeZone = "UTC"): Date | null {
  const c = typeof expr === "string" ? parseCron(expr) : expr;
  if (!c) return null;
  const cursor = new Date(from);
  cursor.setUTCSeconds(0, 0);
  cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
  const limit = 366 * 24 * 60;
  for (let i = 0; i < limit; i++) {
    if (cronMatches(c, cursor, timeZone)) return new Date(cursor);
    cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
  }
  return null;
}
