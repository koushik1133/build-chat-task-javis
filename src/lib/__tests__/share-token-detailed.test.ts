import { describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  query: vi.fn(async () => []),
  queryOne: vi.fn<(sql: string, values?: unknown[]) => Promise<unknown>>(async () => null),
}));
vi.mock("@/lib/dsql", () => db);
import { resolveShareTokenDetailed } from "@/lib/share-tokens";
import { isPurchaseExpired, CHECKOUT_LINK_TTL_MS } from "@/lib/credits/checkout";

const base = { id: "t1", user_id: "u1", kind: "quote", entity_id: "q1", revoked_at: null };

describe("resolveShareTokenDetailed", () => {
  it("reports expired only when the row exists and is past expiry", async () => {
    db.queryOne.mockResolvedValueOnce({ ...base, expires_at: new Date(Date.now() - 1000).toISOString() });
    expect(await resolveShareTokenDetailed("quote", "abcDEF123")).toEqual({ row: null, expired: true });
  });
  it("treats revoked and unknown tokens as not found (not expired)", async () => {
    db.queryOne.mockResolvedValueOnce({ ...base, expires_at: null, revoked_at: new Date().toISOString() });
    expect(await resolveShareTokenDetailed("quote", "abcDEF123")).toEqual({ row: null, expired: false });
    db.queryOne.mockResolvedValueOnce(null);
    expect(await resolveShareTokenDetailed("quote", "abcDEF123")).toEqual({ row: null, expired: false });
    expect(await resolveShareTokenDetailed("quote", "bad token!")).toEqual({ row: null, expired: false });
  });
  it("returns the live row", async () => {
    db.queryOne.mockResolvedValueOnce({ ...base, expires_at: new Date(Date.now() + 60_000).toISOString() });
    const r = await resolveShareTokenDetailed("quote", "abcDEF123");
    expect(r.expired).toBe(false);
    expect(r.row?.id).toBe("t1");
  });
});

describe("isPurchaseExpired", () => {
  const now = Date.now();
  it("expires only pending checkouts past the TTL", () => {
    expect(isPurchaseExpired({ status: "pending", created_at: new Date(now - CHECKOUT_LINK_TTL_MS - 1).toISOString() }, now)).toBe(true);
    expect(isPurchaseExpired({ status: "pending", created_at: new Date(now - 1000).toISOString() }, now)).toBe(false);
    expect(isPurchaseExpired({ status: "paid", created_at: new Date(now - CHECKOUT_LINK_TTL_MS * 5).toISOString() }, now)).toBe(false);
  });
});
