import { describe, expect, it } from "vitest";
import {
  RETRY_DAYS,
  advancePeriod,
  buildPeriodLines,
  canTransition,
  dunningStep,
  membershipMetrics,
  monthlyEquivalent,
  parseBenefits,
  prorate,
  slugify,
  statusAfterFailure,
  type MetricRow,
} from "../pure";

const d = (s: string) => new Date(s);

describe("advancePeriod", () => {
  it("clamps month ends and recovers the anchor day", () => {
    const feb = advancePeriod(d("2026-01-31T10:00:00Z"), "month", 1, 31);
    expect(feb.toISOString()).toBe("2026-02-28T10:00:00.000Z");
    expect(advancePeriod(feb, "month", 1, 31).toISOString()).toBe("2026-03-31T10:00:00.000Z");
  });
  it("handles weeks, quarters and years", () => {
    expect(advancePeriod(d("2026-01-01T00:00:00Z"), "week", 2).toISOString()).toBe("2026-01-15T00:00:00.000Z");
    expect(advancePeriod(d("2026-01-15T00:00:00Z"), "quarter", 1).toISOString()).toBe("2026-04-15T00:00:00.000Z");
    expect(advancePeriod(d("2024-02-29T00:00:00Z"), "year", 1, 29).toISOString()).toBe("2025-02-28T00:00:00.000Z");
  });
});

describe("prorate", () => {
  const base = { periodStart: d("2026-03-01T00:00:00Z"), periodEnd: d("2026-03-31T00:00:00Z") };
  it("credits the unused half and charges the new half", () => {
    const r = prorate({ ...base, oldUnitMinor: 3000, oldQty: 1, newUnitMinor: 6000, newQty: 1, now: d("2026-03-16T00:00:00Z") });
    expect(r.remaining).toBeCloseTo(0.5);
    expect(r.creditMinor).toBe(1500);
    expect(r.chargeMinor).toBe(3000);
    expect(r.netMinor).toBe(1500);
  });
  it("is a credit on downgrade and zero outside the period", () => {
    expect(prorate({ ...base, oldUnitMinor: 6000, oldQty: 1, newUnitMinor: 3000, newQty: 1, now: d("2026-03-16T00:00:00Z") }).netMinor).toBe(-1500);
    expect(prorate({ ...base, oldUnitMinor: 6000, oldQty: 1, newUnitMinor: 3000, newQty: 1, now: d("2026-04-10T00:00:00Z") }).netMinor).toBe(0);
  });
  it("scales with quantity", () => {
    const r = prorate({ ...base, oldUnitMinor: 1000, oldQty: 2, newUnitMinor: 1000, newQty: 5, now: d("2026-03-01T00:00:00Z") });
    expect(r.netMinor).toBe(3000);
  });
});

describe("buildPeriodLines", () => {
  const i = { planName: "Gold", label: "month", unitMinor: 5000, quantity: 2, taxRateId: "tx", productId: null, setupFeeMinor: 0, adjustmentMinor: 0, includePeriod: true };
  it("bills quantity x price", () => {
    const { lines } = buildPeriodLines(i);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ qty: 2, unit_minor: 5000, tax_rate_id: "tx" });
  });
  it("adds setup fee and positive adjustment", () => {
    const { lines, adjustmentLeftMinor } = buildPeriodLines({ ...i, setupFeeMinor: 1000, adjustmentMinor: 700 });
    expect(lines.map((l) => l.unit_minor)).toEqual([1000, 5000, 700]);
    expect(adjustmentLeftMinor).toBe(0);
  });
  it("nets a credit into the period line and carries the rest", () => {
    const a = buildPeriodLines({ ...i, adjustmentMinor: -4000 });
    expect(a.lines).toHaveLength(1);
    expect(a.lines[0].unit_minor).toBe(6000);
    expect(a.adjustmentLeftMinor).toBe(0);
    const b = buildPeriodLines({ ...i, adjustmentMinor: -15000 });
    expect(b.lines[0].unit_minor).toBe(0);
    expect(b.adjustmentLeftMinor).toBe(-5000);
  });
  it("setup-only for a trial", () => {
    const { lines } = buildPeriodLines({ ...i, includePeriod: false, setupFeeMinor: 2500 });
    expect(lines.map((l) => l.unit_minor)).toEqual([2500]);
  });
});

describe("dunning state machine", () => {
  const anchor = d("2026-05-01T00:00:00Z");
  it("retries on day 1, 3 and 7 then expires", () => {
    const days = [1, 2, 3].map((n) => dunningStep(n, anchor));
    expect(days.map((s) => (s.action === "retry" ? Math.round((s.at.getTime() - anchor.getTime()) / 86_400_000) : -1))).toEqual([...RETRY_DAYS]);
    expect(dunningStep(4, anchor)).toEqual({ action: "expire" });
  });
  it("saved-card declines go past_due at once; unpaid links get one grace retry", () => {
    expect(statusAfterFailure("active", 1, true)).toBe("past_due");
    expect(statusAfterFailure("active", 1, false)).toBe("active");
    expect(statusAfterFailure("active", 2, false)).toBe("past_due");
    expect(statusAfterFailure("cancelled", 1, true)).toBe("cancelled");
  });
  it("transitions", () => {
    expect(canTransition("past_due", "active")).toBe(true);
    expect(canTransition("expired", "active")).toBe(false);
    expect(canTransition("paused", "past_due")).toBe(false);
    expect(canTransition("incomplete", "active")).toBe(true);
  });
});

describe("metrics", () => {
  const now = d("2026-06-30T00:00:00Z");
  const row = (o: Partial<MetricRow>): MetricRow => ({ status: "active", amount_minor: 3000, quantity: 1, interval: "month", interval_count: 1, currency: "USD", start_at: "2026-01-10T00:00:00Z", cancelled_at: null, trial_ends_at: null, converted: true, ...o });
  it("normalises MRR across intervals", () => {
    expect(monthlyEquivalent(12000, 1, "year", 1)).toBe(1000);
    expect(monthlyEquivalent(3000, 2, "quarter", 1)).toBe(2000);
    expect(monthlyEquivalent(1200, 1, "week", 1)).toBe(5200);
  });
  it("computes MRR, churn and trial conversion", () => {
    const m = membershipMetrics(
      [
        row({}),
        row({ interval: "year", amount_minor: 12000 }),
        row({ status: "past_due" }),
        row({ status: "cancelled", cancelled_at: "2026-06-20T00:00:00Z" }),
        row({ status: "trialing", start_at: "2026-06-25T00:00:00Z", trial_ends_at: "2026-07-05T00:00:00Z", converted: false }),
        row({ status: "active", trial_ends_at: "2026-02-01T00:00:00Z", converted: true }),
        row({ status: "expired", cancelled_at: "2026-03-01T00:00:00Z", trial_ends_at: "2026-01-20T00:00:00Z", converted: false }),
      ],
      now
    );
    expect(m.active_members).toBe(4);
    expect(m.mrr_minor.USD).toBe(3000 + 1000 + 3000 + 3000);
    expect(m.past_due).toBe(1);
    expect(m.trialing).toBe(1);
    expect(m.churned_30d).toBe(1);
    expect(m.churn_pct).toBe(20);
    expect(m.trial_conversion_pct).toBe(50);
    expect(m.new_by_month).toHaveLength(6);
    expect(m.new_by_month.at(-1)?.count).toBe(1);
  });
  it("is empty-safe", () => {
    const m = membershipMetrics([], now);
    expect(m.churn_pct).toBe(0);
    expect(m.trial_conversion_pct).toBeNull();
    expect(m.primary_currency).toBeNull();
  });
});

describe("helpers", () => {
  it("parses benefits and slugs", () => {
    expect(parseBenefits('[{"label":"Sauna"},"Pool",{"x":1}]')).toEqual([{ label: "Sauna" }, { label: "Pool" }]);
    expect(parseBenefits("nope")).toEqual([]);
    expect(slugify("  Gold Plan — VIP!! ")).toBe("gold-plan-vip");
  });
});
