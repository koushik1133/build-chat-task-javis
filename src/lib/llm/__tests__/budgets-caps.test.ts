import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/dsql", () => ({ query: async () => [], queryOne: async () => null }));
vi.mock("@/lib/credits/ledger", () => ({ getBalance: async () => 1, InsufficientCreditsError: class extends Error {} }));

import { checkBudgetView, LlmBudgetExceededError, parseFeatureCaps, type BudgetView } from "../budgets";
import { llmErrorResponse } from "@/lib/llm-response";

const base: BudgetView = {
  capMicros: null, hardStop: true, allowlist: null, spentMicros: 0, creditsEnforced: false,
  featureCaps: {}, dailyCapMicros: null, spentTodayMicros: 0, spentByFeature: {}, maxTokensPerCall: null, fallbackModel: null,
};

function trip(b: BudgetView, feature?: string): LlmBudgetExceededError {
  try {
    checkBudgetView(b, feature);
  } catch (e) {
    return e as LlmBudgetExceededError;
  }
  throw new Error("expected the budget check to throw");
}

describe("budget caps", () => {
  it("passes under all caps", () => {
    expect(() => checkBudgetView({ ...base, capMicros: 10, spentMicros: 5, dailyCapMicros: 10, spentTodayMicros: 1 }, "agent")).not.toThrow();
  });
  it("names the monthly cap", () => {
    expect(trip({ ...base, capMicros: 10, spentMicros: 10 }).cap).toBe("monthly");
  });
  it("names the daily cap", () => {
    expect(trip({ ...base, dailyCapMicros: 5, spentTodayMicros: 6 }).cap).toBe("daily");
  });
  it("names the feature cap only for that feature", () => {
    const b = { ...base, featureCaps: { receptionist: 100 }, spentByFeature: { receptionist: 120, agent: 999 } };
    expect(() => checkBudgetView(b, "agent")).not.toThrow();
    expect(() => checkBudgetView(b)).not.toThrow();
    const e = trip(b, "receptionist");
    expect(e.cap).toBe("feature");
    expect(e.feature).toBe("receptionist");
  });
  it("maps to 402 with the cap in the body", async () => {
    const res = llmErrorResponse(new LlmBudgetExceededError(120, 100, "feature", "receptionist"));
    expect(res?.status).toBe(402);
    expect(await res?.json()).toMatchObject({ code: "llm_budget_exceeded", cap: "feature", feature: "receptionist" });
  });
  it("parses feature caps defensively", () => {
    expect(parseFeatureCaps('{"a":5,"b":-1,"c":"x"}')).toEqual({ a: 5 });
    expect(parseFeatureCaps("nope")).toEqual({});
  });
});
