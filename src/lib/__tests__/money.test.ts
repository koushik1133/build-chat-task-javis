import { describe, expect, it } from "vitest";
import { computeTotals, lineTotals, LineItemsSchema } from "@/lib/money/items";

describe("computeTotals", () => {
  it("returns zeros for an empty list", () => {
    expect(computeTotals([])).toEqual({ subtotal_minor: 0, tax_minor: 0, total_minor: 0 });
  });

  it("sums lines and applies tax in basis points", () => {
    const t = computeTotals([
      { description: "A", qty: 2, unit_minor: 1000, tax_rate_bp: 1000 }, // 2000 + 200
      { description: "B", qty: 1, unit_minor: 555, tax_rate_bp: 0 }, // 555
    ]);
    expect(t).toEqual({ subtotal_minor: 2555, tax_minor: 200, total_minor: 2755 });
  });

  it("rounds half-up per line, never accumulates float error", () => {
    // 3 × 3.33 = 9.99 → 999 minor; 7.5% tax on 999 = 74.925 → 75
    expect(lineTotals({ description: "x", qty: 3, unit_minor: 333, tax_rate_bp: 750 })).toEqual({ subtotal_minor: 999, tax_minor: 75, total_minor: 1074 });
    // fractional qty: 1.5 × 1001 = 1501.5 → 1502
    expect(lineTotals({ description: "y", qty: 1.5, unit_minor: 1001, tax_rate_bp: 0 }).subtotal_minor).toBe(1502);
    // 0.1 + 0.2 style: 0.7 × 10 = 7.000000000000001
    expect(lineTotals({ description: "z", qty: 0.7, unit_minor: 10, tax_rate_bp: 0 }).subtotal_minor).toBe(7);
  });

  it("always yields integers", () => {
    const t = computeTotals([{ description: "q", qty: 0.333, unit_minor: 12345, tax_rate_bp: 1825 }]);
    for (const v of Object.values(t)) expect(Number.isInteger(v)).toBe(true);
  });

  it("rejects non-integer minor units and out-of-range tax", () => {
    expect(LineItemsSchema.safeParse([{ description: "a", qty: 1, unit_minor: 10.5 }]).success).toBe(false);
    expect(LineItemsSchema.safeParse([{ description: "a", qty: 1, unit_minor: 10, tax_rate_bp: 10_001 }]).success).toBe(false);
    expect(LineItemsSchema.safeParse([{ description: "a", qty: 1, unit_minor: 10 }]).success).toBe(true);
  });
});
