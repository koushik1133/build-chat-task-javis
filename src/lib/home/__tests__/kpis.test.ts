import { describe, expect, it } from "vitest";
import { dayRangeInTz, deltaLabel, formatMinor, monthWindows, pctDelta, sortNeedsYou, sparklineScale } from "../kpis";

describe("home kpis helpers", () => {
  it("pctDelta handles growth, decline and missing baselines", () => {
    expect(pctDelta(150, 100)).toBe(50);
    expect(pctDelta(80, 100)).toBe(-20);
    expect(pctDelta(0, 0)).toBe(0);
    expect(pctDelta(10, 0)).toBeNull();
    expect(pctDelta(Number.NaN, 1)).toBeNull();
    expect(pctDelta(1234, 1000)).toBe(23.4);
  });

  it("deltaLabel renders sign and baseline wording", () => {
    expect(deltaLabel(12.5)).toBe("+12.5% vs last month");
    expect(deltaLabel(-3)).toBe("-3% vs last month");
    expect(deltaLabel(0)).toBe("no change vs last month");
    expect(deltaLabel(null, "vs last week")).toBe("new vs last week");
  });

  it("monthWindows spans this and last month in UTC", () => {
    const w = monthWindows(new Date("2026-03-15T10:00:00Z"));
    expect(w.thisStart.toISOString()).toBe("2026-03-01T00:00:00.000Z");
    expect(w.nextStart.toISOString()).toBe("2026-04-01T00:00:00.000Z");
    expect(w.lastStart.toISOString()).toBe("2026-02-01T00:00:00.000Z");
    const jan = monthWindows(new Date("2026-01-02T00:00:00Z"));
    expect(jan.lastStart.toISOString()).toBe("2025-12-01T00:00:00.000Z");
  });

  it("dayRangeInTz follows the org timezone", () => {
    const now = new Date("2026-06-10T03:30:00Z"); // 23:30 previous day in New York (UTC-4)
    const ny = dayRangeInTz(now, "America/New_York");
    expect(ny.start.toISOString()).toBe("2026-06-09T04:00:00.000Z");
    expect(ny.end.toISOString()).toBe("2026-06-10T04:00:00.000Z");
    const utc = dayRangeInTz(now, "UTC");
    expect(utc.start.toISOString()).toBe("2026-06-10T00:00:00.000Z");
    const bad = dayRangeInTz(now, "Not/AZone");
    expect(bad.start.toISOString()).toBe(utc.start.toISOString());
  });

  it("sparklineScale normalises to 0..1 and handles flat series", () => {
    expect(sparklineScale([10, 20, 30])).toEqual([0, 0.5, 1]);
    expect(sparklineScale([5, 5])).toEqual([0.5, 0.5]);
    expect(sparklineScale([])).toEqual([]);
  });

  it("formatMinor formats currency and compacts large values", () => {
    expect(formatMinor(123456, "USD")).toBe("$1,234.56");
    expect(formatMinor(12_345_678, "USD")).toMatch(/\$123\.5K/);
    expect(formatMinor(1500, "JPY")).toMatch(/1,500/);
  });

  it("sortNeedsYou orders by rank then title", () => {
    const sorted = sortNeedsYou([
      { kind: "deal", id: "1", title: "Zed", detail: "", href: "/", rank: 3 },
      { kind: "approval", id: "2", title: "B", detail: "", href: "/", rank: 0 },
      { kind: "approval", id: "3", title: "A", detail: "", href: "/", rank: 0 },
    ]);
    expect(sorted.map((s) => s.id)).toEqual(["3", "2", "1"]);
  });
});

import { monthWindowsInTz } from "../kpis";

describe("monthWindowsInTz", () => {
  it("rolls the month over at local midnight in the org timezone", () => {
    // 2026-03-01 02:00 UTC is still Feb 28 in Los Angeles (UTC-8).
    const now = new Date("2026-03-01T02:00:00Z");
    const la = monthWindowsInTz(now, "America/Los_Angeles");
    expect(la.thisStart.toISOString()).toBe("2026-02-01T08:00:00.000Z");
    expect(la.nextStart.toISOString()).toBe("2026-03-01T08:00:00.000Z");
    expect(la.lastStart.toISOString()).toBe("2026-01-01T08:00:00.000Z");
    // …but already March in Kolkata (UTC+5:30).
    const kol = monthWindowsInTz(now, "Asia/Kolkata");
    expect(kol.thisStart.toISOString()).toBe("2026-02-28T18:30:00.000Z");
    expect(kol.nextStart.toISOString()).toBe("2026-03-31T18:30:00.000Z");
  });
  it("handles a DST change inside the window and falls back to UTC for bad zones", () => {
    const now = new Date("2026-03-20T12:00:00Z"); // US DST started 2026-03-08
    const ny = monthWindowsInTz(now, "America/New_York");
    expect(ny.thisStart.toISOString()).toBe("2026-03-01T05:00:00.000Z"); // EST
    expect(ny.nextStart.toISOString()).toBe("2026-04-01T04:00:00.000Z"); // EDT
    expect(monthWindowsInTz(now, "Nope/Zone")).toEqual(monthWindows(now));
  });
});
