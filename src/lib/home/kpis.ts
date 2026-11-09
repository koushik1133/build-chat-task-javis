/**
 * Home dashboard — pure, client-safe helpers and the summary payload types.
 * No DB imports here: the client widgets import this module.
 */

export interface KpiTile {
  key: string;
  label: string;
  /** Primary value, already formatted for display. */
  value: string;
  /** Secondary line (e.g. "vs last month"). */
  hint?: string | null;
  /** Percent change vs the comparison period; null when not comparable. */
  deltaPct?: number | null;
  tone?: "neutral" | "good" | "bad" | "warn";
  href?: string;
}

export interface NeedsYouItem {
  kind: "approval" | "sla" | "invoice" | "deal";
  id: string;
  title: string;
  detail: string;
  href: string;
  /** Sortable urgency: lower is more urgent. */
  rank: number;
}

export interface TimelineItem {
  kind: "booking" | "task";
  id: string;
  title: string;
  /** ISO instant (bookings) or null (undated tasks). */
  at: string | null;
  detail?: string | null;
  href: string;
}

export interface AgentRunItem {
  id: string;
  agent: string;
  status: string;
  createdAt: string;
  href: string;
}

export interface SparklineData {
  currency: string;
  points: Array<{ weekStart: string; balance: number }>;
}

export interface HomeSummary {
  generatedAt: string;
  timezone: string;
  currency: string;
  /** Tiles the caller is allowed to see; sections the role cannot view are null. */
  kpis: KpiTile[] | null;
  needsYou: NeedsYouItem[] | null;
  today: TimelineItem[] | null;
  agents: AgentRunItem[] | null;
  cashflow: SparklineData | null;
  demo: { active: boolean; rows: number };
  /** True when the workspace has no business data yet (drives the empty state). */
  empty: boolean;
}

/** Percent change from `previous` to `current`; null when there is no baseline. */
export function pctDelta(current: number, previous: number): number | null {
  if (!Number.isFinite(current) || !Number.isFinite(previous)) return null;
  if (previous === 0) return current === 0 ? 0 : null;
  return Math.round(((current - previous) / Math.abs(previous)) * 1000) / 10;
}

/** Human delta label: "+12.5% vs last month", "no change", or "new" when there is no baseline. */
export function deltaLabel(delta: number | null, suffix = "vs last month"): string {
  if (delta === null) return `new ${suffix}`;
  if (delta === 0) return `no change ${suffix}`;
  const sign = delta > 0 ? "+" : "";
  return `${sign}${delta}% ${suffix}`;
}

/** Month windows (UTC) for "this month" and "last month" relative to `now`. */
export function monthWindows(now: Date): { thisStart: Date; nextStart: Date; lastStart: Date } {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  return {
    thisStart: new Date(Date.UTC(y, m, 1)),
    nextStart: new Date(Date.UTC(y, m + 1, 1)),
    lastStart: new Date(Date.UTC(y, m - 1, 1)),
  };
}

function zonedParts(d: Date, timeZone: string): { y: number; m: number; day: number; h: number; mi: number; s: number } | null {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
    }).formatToParts(d);
    const get = (t: Intl.DateTimeFormatPart["type"]) => Number(parts.find((p) => p.type === t)?.value ?? 0);
    return { y: get("year"), m: get("month") - 1, day: get("day"), h: get("hour"), mi: get("minute"), s: get("second") };
  } catch {
    return null;
  }
}

/** The instant of local midnight on (y, m, day) in `timeZone`; month may overflow (Date.UTC semantics). */
function zonedMidnight(y: number, m: number, day: number, timeZone: string): Date {
  const guess = Date.UTC(y, m, day);
  let instant = guess;
  // Two passes absorb a DST transition sitting between the guess and the real midnight.
  for (let i = 0; i < 2; i++) {
    const p = zonedParts(new Date(instant), timeZone);
    if (!p) return new Date(guess);
    const wallAsUtc = Date.UTC(p.y, p.m, p.day, p.h, p.mi, p.s);
    instant = guess - (wallAsUtc - instant);
  }
  return new Date(instant);
}

/**
 * Month windows for "this month" and "last month" using the org's calendar
 * (midnight on the 1st in `timeZone`), so revenue deltas roll over when the
 * business's month does, not UTC's. Invalid zones fall back to UTC.
 */
export function monthWindowsInTz(now: Date, timeZone: string): { thisStart: Date; nextStart: Date; lastStart: Date } {
  const p = zonedParts(now, timeZone);
  if (!p) return monthWindows(now);
  return {
    thisStart: zonedMidnight(p.y, p.m, 1, timeZone),
    nextStart: zonedMidnight(p.y, p.m + 1, 1, timeZone),
    lastStart: zonedMidnight(p.y, p.m - 1, 1, timeZone),
  };
}

/** Start and end (exclusive) of the calendar day containing `now` in `timeZone`. */
export function dayRangeInTz(now: Date, timeZone: string): { start: Date; end: Date } {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).formatToParts(now);
  } catch {
    return dayRangeInTz(now, "UTC");
  }
  const get = (t: Intl.DateTimeFormatPart["type"]) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  // Local wall clock → elapsed ms since local midnight.
  const sinceMidnight = ((get("hour") * 60 + get("minute")) * 60 + get("second")) * 1000 + (now.getTime() % 1000);
  const start = new Date(now.getTime() - sinceMidnight);
  return { start, end: new Date(start.getTime() + 86_400_000) };
}

/** Normalise a sparkline to 0..1 heights for rendering without a chart library. */
export function sparklineScale(values: number[]): number[] {
  if (values.length === 0) return [];
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (max === min) return values.map(() => 0.5);
  return values.map((v) => (v - min) / (max - min));
}

/** Format minor units in the given currency for tiles (compact when large). */
export function formatMinor(minor: number, currency: string, locale = "en-US"): string {
  const digits = currency === "JPY" || currency === "KRW" ? 0 : 2;
  const amount = minor / 10 ** digits;
  try {
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency,
      notation: Math.abs(amount) >= 100_000 ? "compact" : "standard",
      maximumFractionDigits: Math.abs(amount) >= 100_000 ? 1 : digits,
    }).format(amount);
  } catch {
    return `${amount.toFixed(digits)} ${currency}`;
  }
}

/** Sort "needs you" items by urgency rank then title. */
export function sortNeedsYou(items: NeedsYouItem[]): NeedsYouItem[] {
  return [...items].sort((a, b) => a.rank - b.rank || a.title.localeCompare(b.title));
}
