import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { authRateLimit, clientIp, rateLimit, rateLimitAll, resetRateLimits } from "@/lib/request-limits";

beforeEach(() => {
  resetRateLimits();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
});
afterEach(() => vi.useRealTimers());

describe("rateLimit", () => {
  it("allows up to the limit then blocks", () => {
    expect(rateLimit("k", { limit: 2, windowMs: 1000 })).toMatchObject({ allowed: true, remaining: 1 });
    expect(rateLimit("k", { limit: 2, windowMs: 1000 })).toMatchObject({ allowed: true, remaining: 0 });
    expect(rateLimit("k", { limit: 2, windowMs: 1000 }).allowed).toBe(false);
  });

  it("rolls over when the window expires", () => {
    rateLimit("k", 1, 1000);
    expect(rateLimit("k", 1, 1000).allowed).toBe(false);
    vi.advanceTimersByTime(999);
    expect(rateLimit("k", 1, 1000).allowed).toBe(false);
    vi.advanceTimersByTime(1);
    const r = rateLimit("k", 1, 1000);
    expect(r.allowed).toBe(true);
    expect(r.resetAt).toBe(Date.now() + 1000);
  });

  it("keys are independent", () => {
    rateLimit("a", 1, 1000);
    expect(rateLimit("b", 1, 1000).allowed).toBe(true);
  });
});

describe("rateLimitAll / authRateLimit", () => {
  it("blocks when any window is exhausted", () => {
    const limits = [
      { name: "short", limit: 1, windowMs: 1000 },
      { name: "long", limit: 10, windowMs: 10_000 },
    ];
    expect(rateLimitAll("p", limits).allowed).toBe(true);
    expect(rateLimitAll("p", limits).allowed).toBe(false);
    vi.advanceTimersByTime(1000);
    expect(rateLimitAll("p", limits).allowed).toBe(true);
  });

  it("applies 5/hour then 20/day per IP", () => {
    const mk = (ip: string) => new Request("https://x", { headers: { "x-forwarded-for": `${ip}, 10.0.0.1` } });
    for (let i = 0; i < 5; i++) expect(authRateLimit("signup", mk("1.1.1.1")).allowed).toBe(true);
    expect(authRateLimit("signup", mk("1.1.1.1")).allowed).toBe(false);
    expect(authRateLimit("signup", mk("2.2.2.2")).allowed).toBe(true);
    // Hourly windows roll; daily cap (20) eventually holds.
    for (let h = 1; h <= 3; h++) {
      vi.advanceTimersByTime(60 * 60 * 1000);
      for (let i = 0; i < 5; i++) expect(authRateLimit("signup", mk("1.1.1.1")).allowed).toBe(true);
    }
    vi.advanceTimersByTime(60 * 60 * 1000);
    expect(authRateLimit("signup", mk("1.1.1.1")).allowed).toBe(false);
  });

  it("clientIp falls back sensibly", () => {
    expect(clientIp(new Request("https://x"))).toBe("unknown");
    expect(clientIp(new Request("https://x", { headers: { "x-real-ip": "9.9.9.9" } }))).toBe("9.9.9.9");
  });
});

describe("clientIp trusted hops", () => {
  const mk = (xff: string) => new Request("http://x", { headers: { "x-forwarded-for": xff } });
  it("takes the Nth entry from the right", async () => {
    const { clientIp } = await import("../request-limits");
    expect(clientIp(mk("6.6.6.6, 1.1.1.1, 2.2.2.2"), 1)).toBe("2.2.2.2");
    expect(clientIp(mk("6.6.6.6, 1.1.1.1, 2.2.2.2"), 2)).toBe("1.1.1.1");
    expect(clientIp(mk("6.6.6.6, 1.1.1.1"), 5)).toBe("6.6.6.6");
    expect(clientIp(mk("6.6.6.6, 1.1.1.1"), 0)).toBe("6.6.6.6");
  });
  it("defaults by environment and honours TRUSTED_PROXY_HOPS", async () => {
    const { trustedProxyHops } = await import("../request-limits");
    vi.stubEnv("TRUSTED_PROXY_HOPS", "");
    vi.stubEnv("VERCEL", "");
    vi.stubEnv("NODE_ENV", "test");
    expect(trustedProxyHops()).toBe(0);
    vi.stubEnv("VERCEL", "1");
    expect(trustedProxyHops()).toBe(1);
    vi.stubEnv("TRUSTED_PROXY_HOPS", "2");
    expect(trustedProxyHops()).toBe(2);
    vi.unstubAllEnvs();
  });
});
