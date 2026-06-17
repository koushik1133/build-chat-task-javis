/** Determines if a scheduled automation is due to run right now. */

/** Seconds into the scheduled minute we allow a fire (1s poll → first tick at :00 or :01). */
export const SCHEDULE_FIRE_WINDOW_SEC = 10;

export type ScheduleRow = {
  schedule_time?: string | null;
  schedule_timezone?: string | null;
  schedule_days?: string | null;
  last_scheduled_date?: string | null;
};

export type LocalNow = {
  date: string;       // YYYY-MM-DD
  time: string;       // HH:MM 24h
  second: number;     // 0–59
  weekday: number;    // 0=Sun … 6=Sat
  weekdayShort: string;
};

export function getLocalNow(timezone: string): LocalNow {
  const tz = timezone || "UTC";
  const d = new Date();
  const date = d.toLocaleDateString("en-CA", { timeZone: tz });
  const timeParts = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const hour = timeParts.find(p => p.type === "hour")?.value ?? "00";
  const minute = timeParts.find(p => p.type === "minute")?.value ?? "00";
  const second = parseInt(timeParts.find(p => p.type === "second")?.value ?? "0", 10);
  const weekdayShort = d.toLocaleDateString("en-US", { timeZone: tz, weekday: "short" });
  const weekdayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    date,
    time: `${hour.padStart(2, "0")}:${minute.padStart(2, "0")}`,
    second,
    weekday: weekdayMap[weekdayShort] ?? 0,
    weekdayShort,
  };
}

export function isScheduleDue(row: ScheduleRow, now?: LocalNow): boolean {
  const scheduleTime = normalizeTime(row.schedule_time?.trim() ?? "");
  if (!scheduleTime) return false;

  const local = now ?? getLocalNow(row.schedule_timezone ?? "UTC");

  if (row.last_scheduled_date === local.date) return false;
  if (!dayMatches(row.schedule_days, local)) return false;

  const nowMin = timeToMinutes(local.time);
  const schedMin = timeToMinutes(scheduleTime);

  // Must be the scheduled minute (not a late catch-up on :46)
  if (nowMin !== schedMin) return false;

  // Fire within the first N seconds → e.g. schedule 3:45 → fires at 3:45:00–3:45:29
  return local.second < SCHEDULE_FIRE_WINDOW_SEC;
}

export function msUntilNextScheduleCheck(timezone: string, scheduleTime: string): number {
  const local = getLocalNow(timezone);
  const schedMin = timeToMinutes(normalizeTime(scheduleTime));
  const nowMin = timeToMinutes(local.time);
  let deltaMin = schedMin - nowMin;
  if (deltaMin < 0) deltaMin += 24 * 60;
  if (deltaMin === 0 && local.second >= SCHEDULE_FIRE_WINDOW_SEC) deltaMin = 24 * 60;
  const deltaSec = deltaMin * 60 - local.second;
  return Math.max(100, deltaSec * 1000);
}

function dayMatches(days: string | null | undefined, local: LocalNow): boolean {
  const d = days ?? "daily";
  if (d === "weekdays") return local.weekday >= 1 && local.weekday <= 5;
  const dayKeys = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
  if (dayKeys.includes(d)) return local.weekdayShort.toLowerCase().slice(0, 3) === d;
  return true;
}

function normalizeTime(t: string): string {
  if (!t) return "";
  const [h, m] = t.split(":");
  return `${(h ?? "0").padStart(2, "0")}:${(m ?? "0").padStart(2, "0")}`;
}

function timeToMinutes(t: string): number {
  const [h, m] = normalizeTime(t).split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

export const TIMEZONE_OPTIONS = [
  { value: "America/New_York", label: "Eastern (US)" },
  { value: "America/Chicago", label: "Central (US)" },
  { value: "America/Denver", label: "Mountain (US)" },
  { value: "America/Los_Angeles", label: "Pacific (US)" },
  { value: "Europe/London", label: "London" },
  { value: "Europe/Paris", label: "Paris / CET" },
  { value: "Asia/Kolkata", label: "India (IST)" },
  { value: "Asia/Tokyo", label: "Tokyo" },
  { value: "UTC", label: "UTC" },
];
