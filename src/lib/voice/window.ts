/**
 * Pure scheduling/compliance helpers for voice campaigns: calling windows in
 * the campaign's timezone, do-not-call filtering and phone normalisation.
 * Client-safe (no DB, no env).
 */

export const CAMPAIGN_STATUSES = ["draft", "scheduled", "running", "paused", "done"] as const;
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];

export const TARGET_STATUSES = ["queued", "calling", "answered", "voicemail", "no_answer", "failed", "opted_out", "done"] as const;
export type TargetStatus = (typeof TARGET_STATUSES)[number];

/** Statuses the dialer may still retry (subject to max_attempts). */
export const RETRYABLE_STATUSES: readonly TargetStatus[] = ["queued", "no_answer", "voicemail", "failed"];

export const DNC_TAG = "do_not_call";

/** Minutes to wait before retrying a target that did not answer. */
export const RETRY_GAP_MINUTES = 60;

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** "HH:MM" → minutes since midnight, or null when malformed. */
export function parseHm(value: string | null | undefined): number | null {
  const m = (value ?? "").trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/** Local minutes-since-midnight and weekday (0 = Sunday) for `now` in `tz`. */
export function localClock(now: Date, tz: string): { minutes: number; weekday: number } {
  const zone = isValidTimeZone(tz) ? tz : "UTC";
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: zone, hour: "2-digit", minute: "2-digit", hour12: false, weekday: "short" }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const hour = Number(get("hour")) % 24;
  const minute = Number(get("minute"));
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(get("weekday"));
  return { minutes: hour * 60 + minute, weekday: weekday < 0 ? 0 : weekday };
}

export interface CallWindow {
  window_start: string;
  window_end: string;
  timezone: string;
  /** Default true: never dial on Saturday/Sunday local time. */
  weekdaysOnly?: boolean;
}

/**
 * True when `now` falls inside the campaign's local calling window.
 * Overnight windows (22:00 → 06:00) wrap past midnight. Malformed times
 * fail closed so a typo can never dial around the clock.
 */
export function isWithinWindow(now: Date, w: CallWindow): boolean {
  const start = parseHm(w.window_start);
  const end = parseHm(w.window_end);
  if (start === null || end === null || start === end) return false;
  const { minutes, weekday } = localClock(now, w.timezone);
  if ((w.weekdaysOnly ?? true) && (weekday === 0 || weekday === 6)) return false;
  if (start < end) return minutes >= start && minutes < end;
  return minutes >= start || minutes < end; // overnight
}

/** True when the campaign should be dialling right now. */
export function canDialNow(now: Date, campaign: CallWindow & { status: string; schedule_at: string | null }): boolean {
  if (campaign.status !== "running") return false;
  if (campaign.schedule_at && new Date(campaign.schedule_at).getTime() > now.getTime()) return false;
  return isWithinWindow(now, campaign);
}

/** E.164-ish normalisation: keep digits, restore a leading "+". Empty when too short. */
export function normalizePhone(raw: string | null | undefined): string {
  const num = (raw ?? "").replace(/\D/g, "");
  if (num.length < 7 || num.length > 15) return "";
  return `+${num}`;
}

export function parseTags(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((t): t is string => typeof t === "string") : [];
  } catch {
    return [];
  }
}

export interface DncCandidate {
  phone: string;
  contact_id?: string | null;
  tags?: string | string[] | null;
}

/**
 * Drop anyone on the do-not-call list: opted-out phones, opted-out contact
 * ids, or contacts tagged `do_not_call`.
 */
export function filterDnc<T extends DncCandidate>(candidates: T[], dnc: { phones: Iterable<string>; contactIds?: Iterable<string> }): { allowed: T[]; blocked: T[] } {
  const phones = new Set([...dnc.phones].map((p) => normalizePhone(p)).filter(Boolean));
  const ids = new Set(dnc.contactIds ?? []);
  const allowed: T[] = [];
  const blocked: T[] = [];
  for (const c of candidates) {
    const tags = Array.isArray(c.tags) ? c.tags : parseTags(c.tags);
    const isDnc = phones.has(normalizePhone(c.phone)) || (c.contact_id ? ids.has(c.contact_id) : false) || tags.includes(DNC_TAG);
    (isDnc ? blocked : allowed).push(c);
  }
  return { allowed, blocked };
}

/** Whether a target may be dialled (again) given attempts and retry spacing. */
export function isRetryDue(target: { status: string; attempts: number; last_attempt_at: string | null }, maxAttempts: number, now: Date): boolean {
  if (!RETRYABLE_STATUSES.includes(target.status as TargetStatus)) return false;
  if (target.attempts >= Math.max(1, maxAttempts)) return false;
  if (target.status === "queued" && target.attempts === 0) return true;
  if (!target.last_attempt_at) return true;
  return now.getTime() - new Date(target.last_attempt_at).getTime() >= RETRY_GAP_MINUTES * 60_000;
}

export interface CampaignStats {
  total: number;
  queued: number;
  calling: number;
  answered: number;
  voicemail: number;
  no_answer: number;
  failed: number;
  opted_out: number;
  done: number;
  interested: number;
}

export function emptyStats(): CampaignStats {
  return { total: 0, queued: 0, calling: 0, answered: 0, voicemail: 0, no_answer: 0, failed: 0, opted_out: 0, done: 0, interested: 0 };
}
