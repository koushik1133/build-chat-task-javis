import type { BookingTypeRow } from "@/lib/calendar/booking";

/** Small parsers shared by the booking-type routes (route files may only export handlers). */

export function slugifyType(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 60);
}

export function readTypeBody(raw: unknown): Partial<Record<keyof BookingTypeRow, unknown>> {
  return raw && typeof raw === "object" ? (raw as Partial<Record<keyof BookingTypeRow, unknown>>) : {};
}

export function intField(v: unknown, fallback: number, min: number, max: number): number {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}
