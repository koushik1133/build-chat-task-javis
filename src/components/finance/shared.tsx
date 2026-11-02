"use client";

/** Shared client bits for the inventory / finance / reports pages. */

export { Banner, Empty, ErrorState, Loading, Skeleton, SkeletonList } from "@/components/ui/feedback";
export { Dialog, DialogFooter } from "@/components/ui/dialog";
export { Field } from "@/components/ui/field";
export { Tabs, TabPanel } from "@/components/ui/tabs";

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { ...init, headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) } });
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const fieldErr = data?.detail?.fieldErrors ? Object.entries(data.detail.fieldErrors as Record<string, string[]>).map(([k, v]) => `${k}: ${v.join(", ")}`)[0] : null;
    throw new Error(data?.detail?.formErrors?.[0] ?? fieldErr ?? (typeof data?.detail === "string" ? data.detail : null) ?? data?.error ?? `Request failed (${res.status})`);
  }
  return data as T;
}

export function toMinor(v: string): number {
  return Math.round((Number(v) || 0) * 100);
}
export function fromMinor(minor: number): string {
  return ((minor || 0) / 100).toFixed(2);
}

export function fmtMinutes(min: number | null | undefined): string {
  const m = Math.max(0, Math.round(min ?? 0));
  const h = Math.floor(m / 60);
  return h > 0 ? `${h}h ${String(m % 60).padStart(2, "0")}m` : `${m}m`;
}

export function todayLocalISODate(offsetDays = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const timeFmt = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
/** Locale-aware clock time for an ISO timestamp. */
export function fmtTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : timeFmt.format(d);
}
