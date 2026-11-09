import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  query: vi.fn<(sql: string, values?: unknown[]) => Promise<unknown[]>>(),
  queryOne: vi.fn<(sql: string, values?: unknown[]) => Promise<unknown>>(),
  withRetry: vi.fn(async <T,>(fn: () => Promise<T>) => fn()),
}));
vi.mock("@/lib/dsql", () => db);

import { pruneRateLimits, rateLimitAsync, rateLimitDb, rateLimitStore, resetRateLimits } from "@/lib/request-limits";

describe("rateLimitAsync store selection", () => {
  const env = process.env.RATE_LIMIT_STORE;
  beforeEach(() => resetRateLimits());
  afterEach(() => {
    if (env === undefined) delete process.env.RATE_LIMIT_STORE;
    else process.env.RATE_LIMIT_STORE = env;
  });

  it("defaults to memory and never touches the database", async () => {
    delete process.env.RATE_LIMIT_STORE;
    expect(rateLimitStore()).toBe("memory");
    expect((await rateLimitAsync("m", 1, 1000)).allowed).toBe(true);
    expect((await rateLimitAsync("m", 1, 1000)).allowed).toBe(false);
    expect(db.query).not.toHaveBeenCalled();
  });

  it("uses the db store when RATE_LIMIT_STORE=db", async () => {
    process.env.RATE_LIMIT_STORE = "db";
    const start = new Date().toISOString();
    db.query.mockResolvedValueOnce([]).mockResolvedValueOnce([{ count: 2, window_start: start }]);
    const r = await rateLimitAsync("k", { limit: 5, windowMs: 60_000 });
    expect(r).toMatchObject({ allowed: true, remaining: 3 });
    expect(db.query).toHaveBeenCalledTimes(2);
  });

  it("fails open with a warning when the database errors", async () => {
    process.env.RATE_LIMIT_STORE = "db";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    db.query.mockRejectedValue(new Error("connection refused"));
    const r = await rateLimitAsync("k", 1, 1000);
    expect(r.allowed).toBe(true);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("rateLimitDb", () => {
  it("inserts when no row exists", async () => {
    const start = new Date().toISOString();
    db.query.mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValueOnce([{ count: 1, window_start: start }]);
    db.queryOne.mockResolvedValueOnce(null);
    const r = await rateLimitDb("new", { limit: 3, windowMs: 1000 });
    expect(r).toMatchObject({ allowed: true, remaining: 2 });
    expect(String(db.query.mock.calls[2][0])).toMatch(/INSERT INTO rate_limits/);
  });

  it("denies when the live window is already at the limit", async () => {
    const start = new Date(Date.now() - 100).toISOString();
    db.query.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    db.queryOne.mockResolvedValueOnce({ count: 3, window_start: start });
    const r = await rateLimitDb("full", { limit: 3, windowMs: 1000 });
    expect(r.allowed).toBe(false);
    expect(r.remaining).toBe(0);
    expect(r.resetAt).toBeGreaterThan(Date.now() - 200);
  });

  it("resets an elapsed window in place", async () => {
    const start = new Date().toISOString();
    db.query.mockResolvedValueOnce([{ count: 1, window_start: start }]);
    const r = await rateLimitDb("old", { limit: 3, windowMs: 1000 });
    expect(r).toMatchObject({ allowed: true, remaining: 2 });
    expect(String(db.query.mock.calls[0][0])).toMatch(/SET count = 1/);
  });
});

describe("pruneRateLimits", () => {
  it("returns the deleted count and swallows errors", async () => {
    db.query.mockResolvedValueOnce([{ key: "a" }, { key: "b" }]);
    expect(await pruneRateLimits()).toBe(2);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    db.query.mockRejectedValueOnce(new Error("relation missing"));
    expect(await pruneRateLimits()).toBe(0);
    warn.mockRestore();
  });
});
