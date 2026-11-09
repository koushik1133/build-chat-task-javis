import { describe, expect, it } from "vitest";
import { computeLineTax, computeTotals, effectiveRate, resolveLineRates, parseBreakdown, type TaxRateLike } from "@/lib/money/tax";

const VAT: TaxRateLike = { id: "vat", name: "VAT", rate_bp: 2000, compound: false };
const GST: TaxRateLike = { id: "gst", name: "GST", rate_bp: 500, compound: false };
const PST: TaxRateLike = { id: "pst", name: "PST", rate_bp: 700, compound: true };
const RATES = [VAT, GST, PST];

describe("tax engine", () => {
  it("falls back to inline basis points when no catalogue rate resolves", () => {
    const t = computeTotals([{ qty: 2, unit_minor: 1000, tax_rate_bp: 1000 }], []);
    expect(t).toMatchObject({ subtotal_minor: 2000, tax_minor: 200, total_minor: 2200 });
    expect(t.breakdown).toEqual([{ rate_id: null, name: "Tax 10%", rate_bp: 1000, compound: false, taxable_minor: 2000, tax_minor: 200 }]);
  });

  it("catalogue rate wins over inline bp and groups the breakdown by rate", () => {
    const t = computeTotals(
      [
        { qty: 1, unit_minor: 10000, tax_rate_bp: 999, tax_rate_id: "vat" },
        { qty: 3, unit_minor: 500, tax_rate_id: "vat" },
        { qty: 1, unit_minor: 1000, tax_rate_id: "gst" },
        { qty: 1, unit_minor: 777 },
      ],
      RATES
    );
    expect(t.subtotal_minor).toBe(10000 + 1500 + 1000 + 777);
    expect(t.tax_minor).toBe(2000 + 300 + 50);
    expect(t.breakdown.map((b) => [b.rate_id, b.taxable_minor, b.tax_minor])).toEqual([
      ["gst", 1000, 50],
      ["vat", 11500, 2300],
    ]);
  });

  it("compound rates apply on top of the simple taxes", () => {
    expect(resolveLineRates({ qty: 1, unit_minor: 1, tax_rate_ids: ["pst", "gst"] }, RATES).map((r) => r.id)).toEqual(["gst", "pst"]);
    expect(effectiveRate([GST, PST])).toBeCloseTo(0.05 + 1.05 * 0.07, 10);
    const line = computeLineTax({ qty: 1, unit_minor: 10000, tax_rate_ids: ["gst", "pst"] }, RATES);
    // GST 500 on 10000; PST 7% of 10500 = 735
    expect(line.parts.map((p) => [p.rate_id, p.tax])).toEqual([["gst", 500], ["pst", 735]]);
    expect(line.tax_minor).toBe(1235);
    expect(line.gross_minor).toBe(11235);
  });

  it("inclusive pricing backs the tax out of the unit price", () => {
    const t = computeTotals([{ qty: 1, unit_minor: 12000, tax_rate_id: "vat" }], RATES, { inclusive: true });
    expect(t.subtotal_minor).toBe(10000);
    expect(t.tax_minor).toBe(2000);
    expect(t.total_minor).toBe(12000);
    const compound = computeLineTax({ qty: 1, unit_minor: 11235, tax_rate_ids: ["gst", "pst"] }, RATES, { inclusive: true });
    expect(compound.net_minor).toBe(10000);
    expect(compound.gross_minor).toBe(11235);
  });

  it("per_line vs per_total rounding differ on many small lines", () => {
    // 7 lines of 1 minor unit at 20%: per line each rounds 0.2 → 0; per total 1.4 → 1.
    const items = Array.from({ length: 7 }, () => ({ qty: 1, unit_minor: 1, tax_rate_id: "vat" }));
    expect(computeTotals(items, RATES, { rounding: "per_line" }).tax_minor).toBe(0);
    const perTotal = computeTotals(items, RATES, { rounding: "per_total" });
    expect(perTotal.tax_minor).toBe(1);
    expect(perTotal.breakdown[0].tax_minor).toBe(1);
    expect(perTotal.total_minor).toBe(8);
  });

  it("half-up rounding per line matches the legacy engine", () => {
    // 999 * 7.5% = 74.925 → 75
    expect(computeLineTax({ qty: 3, unit_minor: 333, tax_rate_bp: 750 }, []).tax_minor).toBe(75);
  });

  it("empty input yields zeros and an empty breakdown", () => {
    expect(computeTotals([], RATES)).toEqual({ subtotal_minor: 0, tax_minor: 0, total_minor: 0, breakdown: [] });
  });

  it("parseBreakdown tolerates garbage", () => {
    expect(parseBreakdown(null)).toEqual([]);
    expect(parseBreakdown("nope")).toEqual([]);
    expect(parseBreakdown(JSON.stringify([{ rate_id: "vat", name: "VAT", rate_bp: 2000, taxable_minor: 10, tax_minor: 2 }]))).toEqual([
      { rate_id: "vat", name: "VAT", rate_bp: 2000, compound: false, taxable_minor: 10, tax_minor: 2 },
    ]);
  });
});
