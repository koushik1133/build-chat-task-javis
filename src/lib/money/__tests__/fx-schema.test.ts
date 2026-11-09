import { describe, expect, it } from "vitest";
import { FxRateInputSchema } from "@/lib/money/fx";

describe("FX rate input", () => {
  const base = { base: "USD", quote: "EUR" };
  it("accepts sane decimal strings and numbers", () => {
    expect(FxRateInputSchema.safeParse({ ...base, rate: "0.92" }).success).toBe(true);
    expect(FxRateInputSchema.safeParse({ ...base, rate: 1.0825 }).success).toBe(true);
  });
  it("rejects zero, negative, non-finite and oversized rates", () => {
    expect(FxRateInputSchema.safeParse({ ...base, rate: "0" }).success).toBe(false);
    expect(FxRateInputSchema.safeParse({ ...base, rate: "0.0000000000" }).success).toBe(false);
    expect(FxRateInputSchema.safeParse({ ...base, rate: -1 }).success).toBe(false);
    expect(FxRateInputSchema.safeParse({ ...base, rate: Number.POSITIVE_INFINITY }).success).toBe(false);
    expect(FxRateInputSchema.safeParse({ ...base, rate: "9".repeat(40) }).success).toBe(false);
    expect(FxRateInputSchema.safeParse({ ...base, rate: "1e5" }).success).toBe(false);
  });
});
