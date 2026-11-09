import { createHash } from "crypto";

/** Hash of an event title: lets us detect changes without ever storing the title. */
export function hashSummary(summary: string | null | undefined): string | null {
  const s = (summary ?? "").trim();
  return s ? createHash("sha256").update(s, "utf8").digest("hex").slice(0, 16) : null;
}

export async function httpJson<T>(label: string, url: string, init: RequestInit & { token?: string } = {}): Promise<T> {
  const { token, ...rest } = init;
  const res = await fetch(url, {
    ...rest,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json", ...(rest.headers ?? {}) },
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 204) return undefined as T;
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const err = new Error(`${label} returned ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}`) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
  return (await res.json()) as T;
}

export async function tokenRequest(label: string, url: string, params: Record<string, string>): Promise<{ access_token: string; refresh_token?: string; expires_at: number }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
    signal: AbortSignal.timeout(15_000),
  });
  const data = (await res.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string; expires_in?: number; error_description?: string; error?: string };
  if (!res.ok || !data.access_token) throw new Error(data.error_description ?? data.error ?? `${label} token endpoint returned ${res.status}`);
  return { access_token: data.access_token, refresh_token: data.refresh_token, expires_at: Date.now() + Math.max(60, data.expires_in ?? 3600) * 1000 - 30_000 };
}
