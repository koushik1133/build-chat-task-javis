import { describe, expect, it } from "vitest";
import { aggregateVitalsInJs, percentileCont } from "@/lib/vitals";

describe("percentileCont (JS fallback for percentile_cont)", () => {
  it("matches SQL linear interpolation", () => {
    expect(percentileCont([], 0.75)).toBe(0);
    expect(percentileCont([5], 0.75)).toBe(5);
    expect(percentileCont([1, 2, 3, 4], 0.75)).toBeCloseTo(3.25);
    expect(percentileCont([4, 1, 3, 2], 0.5)).toBeCloseTo(2.5);
  });
});

describe("aggregateVitalsInJs", () => {
  it("groups by path+metric, counts good ratings and sorts busiest first", () => {
    const rows = aggregateVitalsInJs([
      { path: "/a", name: "LCP", value: "100", rating: "good" },
      { path: "/a", name: "LCP", value: 200, rating: "poor" },
      { path: "/b", name: "CLS", value: 0.1, rating: "good" },
      { path: "/a", name: "LCP", value: Number.NaN, rating: null },
    ]);
    expect(rows[0]).toMatchObject({ path: "/a", name: "LCP", samples: 2, good: 1 });
    expect(rows[0].p75).toBeCloseTo(175);
    expect(rows[1]).toMatchObject({ path: "/b", name: "CLS", samples: 1 });
  });
});
