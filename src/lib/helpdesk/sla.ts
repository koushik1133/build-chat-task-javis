/**
 * SLA maths. Pure functions only — no DB, no clock reads — so the due-time
 * calculation is unit-testable and the sweep can run anywhere.
 *
 * Business hours are a fixed Mon–Fri 09:00–17:00 UTC window. Minutes are
 * consumed only inside that window when `business_hours_only` is set.
 */

export const TICKET_PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export type TicketPriority = (typeof TICKET_PRIORITIES)[number];

export const TICKET_STATUSES = ["open", "pending", "resolved", "closed"] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

export const TICKET_SOURCES = ["portal", "widget", "email", "sms", "whatsapp", "manual", "agent"] as const;
export type TicketSource = (typeof TICKET_SOURCES)[number];

export function isTicketPriority(v: unknown): v is TicketPriority {
  return typeof v === "string" && (TICKET_PRIORITIES as readonly string[]).includes(v);
}
export function isTicketStatus(v: unknown): v is TicketStatus {
  return typeof v === "string" && (TICKET_STATUSES as readonly string[]).includes(v);
}
export function isTicketSource(v: unknown): v is TicketSource {
  return typeof v === "string" && (TICKET_SOURCES as readonly string[]).includes(v);
}

export interface PriorityOverride {
  first_response_minutes?: number;
  resolution_minutes?: number;
}
export type PriorityOverrides = Partial<Record<TicketPriority, PriorityOverride>>;

/** The subset of an `sla_policies` row the calculation needs. */
export interface SlaPolicyLike {
  first_response_minutes: number;
  resolution_minutes: number;
  business_hours_only: boolean;
  /** JSON text (as stored) or an already-parsed object. */
  priority_overrides?: string | PriorityOverrides | null;
}

export interface DueTimes {
  firstResponseDueAt: Date;
  resolutionDueAt: Date;
  firstResponseMinutes: number;
  resolutionMinutes: number;
}

export const BUSINESS_START_HOUR = 9; // UTC
export const BUSINESS_END_HOUR = 17; // UTC
const MS_PER_MINUTE = 60_000;

function toPositiveInt(v: unknown): number | undefined {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

/** Tolerant parser for the `priority_overrides` JSON column. Never throws. */
export function parsePriorityOverrides(raw: string | PriorityOverrides | null | undefined): PriorityOverrides {
  let obj: unknown = raw;
  if (typeof raw === "string") {
    try {
      obj = JSON.parse(raw);
    } catch {
      return {};
    }
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return {};
  const out: PriorityOverrides = {};
  for (const p of TICKET_PRIORITIES) {
    const entry = (obj as Record<string, unknown>)[p];
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const fr = toPositiveInt(e.first_response_minutes);
    const rs = toPositiveInt(e.resolution_minutes);
    if (fr !== undefined || rs !== undefined) {
      out[p] = { ...(fr !== undefined ? { first_response_minutes: fr } : {}), ...(rs !== undefined ? { resolution_minutes: rs } : {}) };
    }
  }
  return out;
}

function isWeekend(d: Date): boolean {
  const day = d.getUTCDay();
  return day === 0 || day === 6;
}

/** Move `d` forward to the next instant inside business hours (no-op if already inside). */
export function nextBusinessInstant(d: Date): Date {
  const out = new Date(d.getTime());
  for (let guard = 0; guard < 14; guard++) {
    if (isWeekend(out)) {
      out.setUTCDate(out.getUTCDate() + 1);
      out.setUTCHours(BUSINESS_START_HOUR, 0, 0, 0);
      continue;
    }
    const hour = out.getUTCHours() + out.getUTCMinutes() / 60 + out.getUTCSeconds() / 3600;
    if (hour < BUSINESS_START_HOUR) {
      out.setUTCHours(BUSINESS_START_HOUR, 0, 0, 0);
      return out;
    }
    if (hour >= BUSINESS_END_HOUR) {
      out.setUTCDate(out.getUTCDate() + 1);
      out.setUTCHours(BUSINESS_START_HOUR, 0, 0, 0);
      continue;
    }
    return out;
  }
  return out;
}

/** Add `minutes` of business time (Mon–Fri 09:00–17:00 UTC) to `start`. */
export function addBusinessMinutes(start: Date, minutes: number): Date {
  let cursor = nextBusinessInstant(start);
  let remaining = Math.max(0, minutes);
  for (let guard = 0; guard < 10_000 && remaining > 0; guard++) {
    const endOfDay = new Date(cursor.getTime());
    endOfDay.setUTCHours(BUSINESS_END_HOUR, 0, 0, 0);
    const available = (endOfDay.getTime() - cursor.getTime()) / MS_PER_MINUTE;
    if (remaining <= available) {
      return new Date(cursor.getTime() + remaining * MS_PER_MINUTE);
    }
    remaining -= available;
    const next = new Date(endOfDay.getTime());
    next.setUTCDate(next.getUTCDate() + 1);
    next.setUTCHours(BUSINESS_START_HOUR, 0, 0, 0);
    cursor = nextBusinessInstant(next);
  }
  return cursor;
}

/** Effective targets for a priority after overrides. */
export function effectiveMinutes(policy: SlaPolicyLike, priority: TicketPriority): { first: number; resolution: number } {
  const overrides = parsePriorityOverrides(policy.priority_overrides);
  const o = overrides[priority] ?? {};
  return {
    first: toPositiveInt(o.first_response_minutes) ?? toPositiveInt(policy.first_response_minutes) ?? 60,
    resolution: toPositiveInt(o.resolution_minutes) ?? toPositiveInt(policy.resolution_minutes) ?? 1440,
  };
}

/**
 * Due timestamps for a ticket created at `createdAt` under `policy`.
 * `business_hours_only` skips weekends and counts only 09:00–17:00 UTC.
 */
export function computeDueTimes(policy: SlaPolicyLike, priority: TicketPriority, createdAt: Date | string): DueTimes {
  const start = typeof createdAt === "string" ? new Date(createdAt) : new Date(createdAt.getTime());
  if (Number.isNaN(start.getTime())) throw new Error("computeDueTimes: invalid createdAt");
  const { first, resolution } = effectiveMinutes(policy, priority);
  const add = policy.business_hours_only
    ? (m: number) => addBusinessMinutes(start, m)
    : (m: number) => new Date(start.getTime() + m * MS_PER_MINUTE);
  return {
    firstResponseDueAt: add(first),
    resolutionDueAt: add(resolution),
    firstResponseMinutes: first,
    resolutionMinutes: resolution,
  };
}

export type SlaHealth = "none" | "ok" | "warning" | "breached" | "met";

/**
 * UI helper: how a due time looks right now. "warning" = less than 25% of the
 * window (or 30 min, whichever is larger) remains.
 */
export function slaHealth(
  dueAt: string | Date | null | undefined,
  satisfiedAt: string | Date | null | undefined,
  now: Date = new Date(),
  windowMinutes?: number
): SlaHealth {
  if (!dueAt) return "none";
  if (satisfiedAt) return "met";
  const due = new Date(dueAt).getTime();
  if (Number.isNaN(due)) return "none";
  const remainingMin = (due - now.getTime()) / MS_PER_MINUTE;
  if (remainingMin <= 0) return "breached";
  const threshold = Math.max(30, windowMinutes ? windowMinutes * 0.25 : 0);
  return remainingMin <= threshold ? "warning" : "ok";
}

/** "2h 15m" / "-45m" style countdown text. */
export function formatCountdown(dueAt: string | Date, now: Date = new Date()): string {
  const diff = new Date(dueAt).getTime() - now.getTime();
  const sign = diff < 0 ? "-" : "";
  const abs = Math.abs(diff);
  const totalMin = Math.floor(abs / MS_PER_MINUTE);
  const days = Math.floor(totalMin / 1440);
  const hours = Math.floor((totalMin % 1440) / 60);
  const mins = totalMin % 60;
  if (days > 0) return `${sign}${days}d ${hours}h`;
  if (hours > 0) return `${sign}${hours}h ${mins}m`;
  return `${sign}${mins}m`;
}
