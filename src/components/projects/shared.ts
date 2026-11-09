"use client";

import type { Tone } from "@/components/ui/pill";
import type { MilestoneStatus, ProjectStatus, TaskPriority } from "@/lib/projects/pure";

/** Client-side helpers for the Projects pages (no DB imports). */

export async function readError(res: Response, fallback: string): Promise<string> {
  const d = (await res.json().catch(() => ({}))) as { detail?: unknown; error?: string };
  if (typeof d.detail === "string") return d.detail;
  const form = d.detail as { formErrors?: string[]; fieldErrors?: Record<string, string[]> } | undefined;
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

export const PROJECT_TONE: Record<ProjectStatus, Tone> = { planning: "neutral", active: "info", on_hold: "warning", done: "success", cancelled: "danger" };
export const MILESTONE_TONE: Record<MilestoneStatus, Tone> = { open: "neutral", done: "success" };
export const PRIORITY_TONE: Record<TaskPriority, Tone> = { low: "neutral", medium: "info", high: "warning", urgent: "danger" };

export function fmtDay(ymd: string | null | undefined): string {
  if (!ymd) return "—";
  const d = new Date(`${ymd.slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? "—" : new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).format(d);
}

export function fmtDue(iso: string | null | undefined): string {
  if (!iso) return "No due date";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(d);
}

export function isPast(iso: string | null | undefined): boolean {
  return Boolean(iso) && new Date(iso as string).getTime() < Date.now();
}

export function hours(minutes: number): string {
  const h = Math.round((minutes / 60) * 10) / 10;
  return `${h}h`;
}

/** Local "YYYY-MM-DDTHH:mm" → ISO instant, or null for empty. */
export function localToIso(local: string): string | null {
  if (!local) return null;
  const d = new Date(local);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function isoToLocal(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export interface MemberOption {
  id: string;
  label: string;
}

/** Team members (user ids) for assignee / owner pickers; silently empty when the caller lacks the team area. */
export async function loadMemberOptions(selfId?: string | null): Promise<MemberOption[]> {
  try {
    const d = await jsonFetch<{ members: Array<{ userId: string | null; email: string | null; role: string; isSelf: boolean }> }>("/api/team");
    const out: MemberOption[] = [];
    for (const m of d.members) {
      if (!m.userId) continue;
      out.push({ id: m.userId, label: m.isSelf ? `Me${m.email ? ` (${m.email})` : ""}` : (m.email ?? `${m.role} · ${m.userId.slice(0, 8)}`) });
    }
    if (selfId && !out.some((o) => o.id === selfId)) out.unshift({ id: selfId, label: "Me" });
    return out;
  } catch {
    return selfId ? [{ id: selfId, label: "Me" }] : [];
  }
}

export function memberLabel(options: MemberOption[], id: string | null | undefined): string {
  if (!id) return "Unassigned";
  return options.find((o) => o.id === id)?.label ?? `${id.slice(0, 8)}…`;
}
