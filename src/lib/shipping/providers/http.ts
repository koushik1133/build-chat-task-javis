import { ShippingError } from "../types";

/** Fixed-host JSON client for carrier APIs: timeout, no redirects, errors never echo credentials. */
export async function carrierFetch<T>(url: string, init: { method?: string; headers: Record<string, string>; body?: unknown }, what: string): Promise<T> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 20_000);
  try {
    const res = await fetch(url, {
      method: init.method ?? "GET",
      headers: { "Content-Type": "application/json", Accept: "application/json", ...init.headers },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      redirect: "error",
      signal: ctl.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new ShippingError("rate_failed", `${what} failed (${res.status})`, 502);
    return (text ? JSON.parse(text) : {}) as T;
  } catch (err) {
    if (err instanceof ShippingError) throw err;
    throw new ShippingError("rate_failed", `${what} failed: ${err instanceof Error && err.name === "AbortError" ? "timed out" : "network error"}`, 502);
  } finally {
    clearTimeout(timer);
  }
}

export function envKey(name: "EASYPOST_API_KEY" | "SHIPPO_API_KEY"): string | null {
  // Platform-level keys are a development fallback only; production orgs connect their own credentials.
  if (process.env.NODE_ENV === "production") return null;
  return process.env[name]?.trim() || null;
}

export const minorFromDecimal = (v: unknown): number => Math.round(Number.parseFloat(String(v)) * 100) || 0;
export const gramsToOz = (g: number): number => Math.max(0.1, Math.round((g / 28.3495) * 100) / 100);
export const cmToIn = (cm: number | undefined): number | undefined => (cm ? Math.round((cm / 2.54) * 100) / 100 : undefined);
export const loc = (...parts: Array<string | null | undefined>): string | null => parts.filter(Boolean).join(", ").slice(0, 200) || null;
