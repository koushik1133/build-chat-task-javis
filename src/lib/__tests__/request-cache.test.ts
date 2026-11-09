import { beforeEach, describe, expect, it, vi } from "vitest";

const q = vi.hoisted(() => ({ query: vi.fn(), queryOne: vi.fn() }));
vi.mock("@/lib/dsql", () => ({ query: q.query, queryOne: q.queryOne }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }) }));
vi.mock("@/lib/supabase/server", () => ({ requireUser: async () => ({ user: { id: "u1", email: "a@b.c" } }) }));

import { mapCacheImpl, requestMemo } from "@/lib/request-cache";

describe("requestMemo", () => {
  beforeEach(() => {
    q.query.mockReset();
    q.queryOne.mockReset();
  });

  it("is a transparent passthrough when no cache implementation is available", async () => {
    const fn = vi.fn(async (id: string) => id.toUpperCase());
    const memo = requestMemo(fn, null);
    expect(await memo("a")).toBe("A");
    expect(await memo("a")).toBe("A");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("dedupes identical calls within one request with a cache implementation", async () => {
    const fn = vi.fn(async (id: string) => id.toUpperCase());
    const memo = requestMemo(fn, mapCacheImpl());
    const [a, b] = await Promise.all([memo("a"), memo("a")]);
    expect(a).toBe("A");
    expect(b).toBe("A");
    await memo("b");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("getOrgSettings runs one SELECT per data id per request (memoised loader)", async () => {
    q.queryOne.mockResolvedValue({ settings: JSON.stringify({ locale: "es", currency: "eur", timezone: "UTC" }) });
    const mod = await import("@/lib/org-settings");
    const memo = requestMemo(mod.loadOrgSettings, mapCacheImpl());
    const [s1, s2] = await Promise.all([memo("org-1"), memo("org-1")]);
    expect(s1.locale).toBe("es");
    expect(s2.currency).toBe("EUR");
    expect(q.queryOne).toHaveBeenCalledTimes(1);
    await memo("org-2");
    expect(q.queryOne).toHaveBeenCalledTimes(2);
  });

  it("getBranding runs one SELECT per data id per request (memoised loader)", async () => {
    q.queryOne.mockResolvedValue({ brand_name: "Acme", logo_url: null, primary_color: "#112233", accent_color: "#445566", email_footer: null, custom_domain: null, support_email: null, favicon_url: null, updated_at: null });
    const mod = await import("@/lib/branding");
    const memo = requestMemo(mod.loadBranding, mapCacheImpl());
    await Promise.all([memo("org-1"), memo("org-1"), memo("org-1")]);
    expect(q.queryOne).toHaveBeenCalledTimes(1);
    expect((await memo("org-1")).brand_name).toBe("Acme");
  });

  it("buildChannelNav runs one GROUP BY per data id per request (memoised loader)", async () => {
    q.query.mockResolvedValue([{ platform: "instagram", count: "2" }]);
    const mod = await import("@/lib/nav/channel-nav");
    const memo = requestMemo(mod.loadChannelNav, mapCacheImpl());
    await Promise.all([memo("org-1"), memo("org-1")]);
    expect(q.query).toHaveBeenCalledTimes(1);
  });

  it("listUserOrgs memoised loader is keyed by user id", async () => {
    q.query.mockResolvedValue([]);
    const mod = await import("@/lib/auth/scope");
    const memo = requestMemo(mod.loadUserOrgs, mapCacheImpl());
    await Promise.all([memo("u1"), memo("u1"), memo("u2")]);
    expect(q.query).toHaveBeenCalledTimes(2);
  });
});
