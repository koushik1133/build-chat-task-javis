"use client";

import type { Tone } from "@/components/ui/pill";
import type { LeaveStatus, ShiftStatus } from "@/lib/workforce/pure";

/** Client-side helpers for the Workforce page (no DB imports). */

export async function readError(res: Response, fallback: string): Promise<string> {
  const d = (await res.json().catch(() => ({}))) as { detail?: unknown; error?: string; conflicts?: Array<{ message: string }> };
  if (Array.isArray(d.conflicts) && d.conflicts.length) return d.conflicts.map((c) => c.message).join(" ");
  if (typeof d.detail === "string") return d.detail;
  const form = (d.detail as { formErrors?: string[]; fieldErrors?: Record<string, string[]> } | undefined);
  if (form?.fieldErrors) {
    const first = Object.entries(form.fieldErrors)[0];
    if (first) return `${first[0]}: ${first[1][0]}`;
  }
  if (form?.formErrors?.[0]) return form.formErrors[0];
  return d.error ? `${fallback} (${d.error})` : `${fallback} (${res.status})`;
}

export async function jsonFetch<T>(url: string, init?: RequestInit & { fallback?: string }): Promise<T> {
  const res = await fetch(url, { cache: "no-store", ...init, headers: { ...(init?.body ? { "Content-Type": "application/json" } : {}), ...(init?.headers ?? {}) } });
  if (!res.ok) throw new Error(await readError(res, init?.fallback ?? "Request failed"));
  return (await res.json()) as T;
}

export const SHIFT_TONE: Record<ShiftStatus, Tone> = { draft: "neutral", published: "info", confirmed: "success", swapped: "violet", cancelled: "danger" };
export const LEAVE_TONE: Record<LeaveStatus, Tone> = { pending: "warning", approved: "success", rejected: "danger", cancelled: "neutral" };

export function fmtTime(iso: string, tz: string): string {
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit", timeZone: tz }).format(new Date(iso));
}
export function fmtDateTime(iso: string, tz: string): string {
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: tz }).format(new Date(iso));
}
export function fmtDay(ymd: string, opts: Intl.DateTimeFormatOptions = { weekday: "short", month: "short", day: "numeric" }): string {
  return new Intl.DateTimeFormat(undefined, { ...opts, timeZone: "UTC" }).format(new Date(`${ymd}T00:00:00Z`));
}
export function hours(minutes: number): string {
  const h = Math.round((minutes / 60) * 10) / 10;
  return `${h}h`;
}
export function money(minor: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(minor / 100);
  } catch {
    return `${(minor / 100).toFixed(2)} ${currency}`;
  }
}

/** Local "YYYY-MM-DDTHH:mm" for <input type=datetime-local> from an ISO instant in tz. */
export function toLocalInput(iso: string, tz: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(iso)).map((p) => [p.type, p.value])
  );
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

/** ISO instant for a local "YYYY-MM-DDTHH:mm" in tz (iterative offset fix). */
export function fromLocalInput(local: string, tz: string): string {
  const [d, t] = local.split("T");
  const [y, m, day] = d.split("-").map(Number);
  const [hh, mm] = (t ?? "00:00").split(":").map(Number);
  const target = Date.UTC(y, m - 1, day, hh, mm);
  let guess = target;
  for (let i = 0; i < 3; i++) {
    const p = Object.fromEntries(
      new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(guess)).map((x) => [x.type, x.value])
    );
    const wall = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute);
    const diff = wall - target;
    if (diff === 0) break;
    guess -= diff;
  }
  return new Date(guess).toISOString();
}

export function todayYmd(): string {
  return new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}
