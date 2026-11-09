import { describe, expect, it, vi } from "vitest";
import { DbError, isConcurrencyConflict, retryDelayMs, withRetry } from "@/lib/dsql";

const pgErr = (code: string, message = "x") => Object.assign(new Error(message), { code });

describe("isConcurrencyConflict", () => {
  it("recognises SQLSTATE 40001, OC000 and OC001 (bare, wrapped, or in the message)", () => {
    expect(isConcurrencyConflict(pgErr("40001"))).toBe(true);
    expect(isConcurrencyConflict(pgErr("OC000"))).toBe(true);
    expect(isConcurrencyConflict(pgErr("OC001"))).toBe(true);
    expect(isConcurrencyConflict(new Error("change conflicts with another transaction (OC000)"))).toBe(true);
    expect(isConcurrencyConflict(new Error("schema has been updated by another transaction, OC001"))).toBe(true);
    expect(isConcurrencyConflict(new DbError("wrapped", pgErr("40001")))).toBe(true);
    expect(isConcurrencyConflict(new Error("could not serialize access due to concurrent update (serialization failure)"))).toBe(true);
  });
  it("does not treat ordinary errors as conflicts", () => {
    expect(isConcurrencyConflict(pgErr("23505", "duplicate key"))).toBe(false);
    expect(isConcurrencyConflict(new Error("boom"))).toBe(false);
    expect(isConcurrencyConflict(null)).toBe(false);
  });
});

describe("retryDelayMs", () => {
  it("is jittered (50-100% of the exponential base) and capped at 1s", () => {
    expect(retryDelayMs(0, () => 0)).toBe(25);
    expect(retryDelayMs(0, () => 0.999)).toBeLessThanOrEqual(50);
    expect(retryDelayMs(2, () => 0)).toBe(100);
    for (const a of [5, 10, 40]) expect(retryDelayMs(a, () => 0.999999)).toBeLessThanOrEqual(1000);
    expect(retryDelayMs(3, () => 0.1)).not.toBe(retryDelayMs(3, () => 0.9));
  });
});

describe("withRetry", () => {
  it("retries conflicts then succeeds", async () => {
    vi.useFakeTimers();
    let n = 0;
    const p = withRetry(async () => { if (++n < 3) throw pgErr("OC000"); return "ok"; });
    await vi.runAllTimersAsync();
    await expect(p).resolves.toBe("ok");
    expect(n).toBe(3);
    vi.useRealTimers();
  });
  it("gives up after `attempts` and rethrows non-conflict errors immediately", async () => {
    vi.useFakeTimers();
    let n = 0;
    const p = withRetry(async () => { n++; throw pgErr("40001"); }, 3);
    p.catch(() => undefined);
    await vi.runAllTimersAsync();
    await expect(p).rejects.toMatchObject({ code: "40001" });
    expect(n).toBe(3);
    vi.useRealTimers();
    let m = 0;
    await expect(withRetry(async () => { m++; throw new Error("fatal"); })).rejects.toThrow("fatal");
    expect(m).toBe(1);
  });
});
