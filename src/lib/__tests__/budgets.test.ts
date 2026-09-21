import { beforeEach, describe, expect, it, vi } from "vitest";

const queryOne = vi.fn();
const query = vi.fn();
vi.mock("@/lib/dsql", () => ({
  queryOne: (...args: unknown[]) => queryOne(...args),
  query: (...args: unknown[]) => query(...args),
}));

import { assertBudget, getBudget, LlmBudgetExceededError, setBudget } from "@/lib/llm/budgets";

function mockDb(row: Record<string, unknown> | null, spent: number) {
  queryOne.mockImplementation(async (sql: string) => {
    if (sql.includes("FROM ai_budgets")) return row;
    if (sql.includes("FROM ai_usage")) return { total: String(spent) };
    return null;
  });
}

describe("getBudget", () => {
  beforeEach(() => {
    queryOne.mockReset();
    query.mockReset();
  });

  it("returns defaults when no row exists", async () => {
    mockDb(null, 0);
    const b = await getBudget("u1");
    expect(b).toEqual({ capMicros: null, hardStop: true, allowlist: null, spentMicros: 0 });
  });

  it("parses the allowlist and numeric columns", async () => {
    mockDb({ monthly_cap_micros: "5000000", hard_stop: false, model_allowlist: '["groq"]' }, 1234);
    const b = await getBudget("u1");
    expect(b.capMicros).toBe(5_000_000);
    expect(b.hardStop).toBe(false);
    expect(b.allowlist).toEqual(["groq"]);
    expect(b.spentMicros).toBe(1234);
  });

  it("tolerates a corrupt allowlist and DB errors", async () => {
    queryOne.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM ai_budgets")) return { monthly_cap_micros: null, hard_stop: true, model_allowlist: "{oops" };
      throw new Error("db down");
    });
    const b = await getBudget("u1");
    expect(b.allowlist).toBeNull();
    expect(b.spentMicros).toBe(0);
  });
});

describe("assertBudget", () => {
  beforeEach(() => {
    queryOne.mockReset();
    query.mockReset();
  });

  it("throws LlmBudgetExceededError at the cap when hard stop is on", async () => {
    mockDb({ monthly_cap_micros: 1_000_000, hard_stop: true, model_allowlist: null }, 1_000_000);
    await expect(assertBudget("u1")).rejects.toBeInstanceOf(LlmBudgetExceededError);
    await expect(assertBudget("u1")).rejects.toThrow(/1\.00 of 1\.00 USD/);
  });

  it("passes when under the cap", async () => {
    mockDb({ monthly_cap_micros: 1_000_000, hard_stop: true, model_allowlist: null }, 999_999);
    await expect(assertBudget("u1")).resolves.toMatchObject({ spentMicros: 999_999 });
  });

  it("does not throw when hard stop is off or there is no cap", async () => {
    mockDb({ monthly_cap_micros: 1_000_000, hard_stop: false, model_allowlist: null }, 5_000_000);
    await expect(assertBudget("u1")).resolves.toBeTruthy();
    mockDb(null, 5_000_000);
    await expect(assertBudget("u1")).resolves.toBeTruthy();
  });
});

describe("setBudget", () => {
  beforeEach(() => {
    queryOne.mockReset();
    query.mockReset();
  });

  it("inserts when no row exists", async () => {
    queryOne.mockResolvedValue(null);
    await setBudget("u1", { capMicros: 2_000_000, hardStop: false, allowlist: ["gemini"] });
    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO ai_budgets/);
    expect(params).toEqual(["u1", 2_000_000, false, '["gemini"]']);
  });

  it("updates and preserves unspecified fields", async () => {
    queryOne.mockResolvedValue({ user_id: "u1", monthly_cap_micros: 7, hard_stop: true, model_allowlist: '["groq"]' });
    await setBudget("u1", { capMicros: null });
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/UPDATE ai_budgets/);
    expect(params).toEqual(["u1", null, true, '["groq"]']);
  });
});
