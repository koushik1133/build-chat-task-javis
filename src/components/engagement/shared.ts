"use client";

/** Tiny fetch helpers for the engagement UI. */
export async function apiJson<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const { json, ...rest } = init ?? {};
  const res = await fetch(path, {
    ...rest,
    headers: { ...(json !== undefined ? { "Content-Type": "application/json" } : {}), ...(rest.headers ?? {}) },
    body: json !== undefined ? JSON.stringify(json) : rest.body,
    credentials: "same-origin",
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const detail = data.detail;
    const msg = typeof detail === "string" ? detail : detail && typeof detail === "object" && "fieldErrors" in detail ? Object.values((detail as { fieldErrors: Record<string, string[]> }).fieldErrors).flat()[0] : null;
    throw new Error(msg ?? (typeof data.error === "string" ? (data.error === "plan_limit" ? "Not included in your plan. Upgrade under Settings, Plan & usage." : data.error) : `Request failed (${res.status})`));
  }
  return data as T;
}

export const errMsg = (e: unknown, fallback = "Something went wrong") => (e instanceof Error ? e.message : fallback);
export const pct = (v: number | null) => (v === null ? "-" : `${v}`);
