import { beforeEach, describe, expect, it, vi } from "vitest";

const query = vi.fn();
const queryOne = vi.fn();
vi.mock("@/lib/dsql", () => ({
  query: (...args: unknown[]) => query(...args),
  queryOne: (...args: unknown[]) => queryOne(...args),
  withRetry: (fn: () => unknown) => fn(),
}));

import { createTimeEntry, stopTimer } from "@/lib/finance/time";

const base = { rate_minor: 0, currency: "USD", billable: true };

function entryRow(over: Record<string, unknown> = {}) {
  return {
    id: "te1", user_id: "org", member_id: "u1", ref_kind: null, ref_id: null, description: null, started_at: "2026-01-01T09:00:00Z",
    ended_at: null, minutes: null, rate_minor: "0", currency: "USD", billable: true, invoice_id: null, created_at: "", ...over,
  };
}

beforeEach(() => {
  query.mockReset();
  queryOne.mockReset();
});

describe("createTimeEntry running-timer uniqueness", () => {
  it("starts a timer with a conditional INSERT (the uniqueness check is inside the statement)", async () => {
    query.mockResolvedValue([{ id: "x" }]);
    queryOne.mockResolvedValue(entryRow());
    await createTimeEntry("org", { ...base }, "u1");
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("INSERT INTO time_entries");
    expect(sql).toContain("WHERE NOT EXISTS (SELECT 1 FROM time_entries WHERE user_id = $2 AND member_id = $3 AND ended_at IS NULL)");
    expect(sql).toContain("RETURNING id");
    expect(params[1]).toBe("org");
    expect(params[2]).toBe("u1");
    // No separate SELECT-then-INSERT.
    expect(query.mock.calls.filter(([s]) => String(s).startsWith("SELECT"))).toHaveLength(0);
  });

  it("rejects a second running timer when the conditional INSERT inserts nothing", async () => {
    query.mockResolvedValue([]);
    await expect(createTimeEntry("org", { ...base }, "u1")).rejects.toThrow(/already running/);
  });

  it("a completed entry (ended_at / minutes given) is inserted unconditionally", async () => {
    query.mockResolvedValue([]);
    queryOne.mockResolvedValue(entryRow({ ended_at: "2026-01-01T10:00:00Z", minutes: 60 }));
    await createTimeEntry("org", { ...base, minutes: 60 }, "u1");
    const [sql] = query.mock.calls[0] as [string];
    expect(sql).toContain("VALUES ($1");
    expect(sql).not.toContain("NOT EXISTS");
  });
});

describe("stopTimer", () => {
  it("stops with a conditional UPDATE and is idempotent for an already-stopped entry", async () => {
    queryOne.mockResolvedValueOnce(entryRow()).mockResolvedValueOnce(entryRow({ ended_at: "2026-01-01T09:30:00Z", minutes: 30 }));
    query.mockResolvedValue([]);
    const out = await stopTimer("org", "te1", "2026-01-01T09:30:00Z");
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("AND ended_at IS NULL");
    expect(params).toEqual(["te1", "org", "2026-01-01T09:30:00Z", 30]);
    expect(out.minutes).toBe(30);

    query.mockClear();
    queryOne.mockResolvedValue(entryRow({ ended_at: "2026-01-01T09:30:00Z", minutes: 30 }));
    await stopTimer("org", "te1");
    expect(query).not.toHaveBeenCalled();
  });
});
