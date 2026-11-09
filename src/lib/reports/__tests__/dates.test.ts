import { describe, expect, it } from "vitest";
import { parseDateInput, resolvePreset } from "@/lib/reports/dates";
import { nextRunAt, inQuietHours, quietHoursEnd } from "@/lib/reports/schedule";

describe("relative date ranges in the org time zone", () => {
  const now = new Date("2026-03-15T02:30:00Z"); // 15 Mar 08:00 IST, 14 Mar 19:30 Los Angeles

  it("this_month / last_month roll on the local calendar", () => {
    const ist = resolvePreset("this_month", now, "Asia/Kolkata");
    expect(ist.from.toISOString()).toBe("2026-02-28T18:30:00.000Z");
    expect(ist.to.toISOString()).toBe("2026-03-31T18:30:00.000Z");
    const la = resolvePreset("last_month", now, "America/Los_Angeles");
    expect(la.from.toISOString()).toBe("2026-02-01T08:00:00.000Z");
    expect(la.to.toISOString()).toBe("2026-03-01T08:00:00.000Z");
  });

  it("today differs across zones for the same instant", () => {
    expect(resolvePreset("today", now, "Asia/Kolkata").from.toISOString()).toBe("2026-03-14T18:30:00.000Z");
    expect(resolvePreset("today", now, "America/Los_Angeles").from.toISOString()).toBe("2026-03-14T07:00:00.000Z"); // PDT
  });

  it("last_30_days ends tomorrow midnight and spans 30 local days", () => {
    const r = resolvePreset("last_30_days", now, "UTC");
    expect(r.to.toISOString()).toBe("2026-03-16T00:00:00.000Z");
    expect((r.to.getTime() - r.from.getTime()) / 86_400_000).toBe(30);
  });

  it("this_week starts on Monday; quarters and years align", () => {
    expect(resolvePreset("this_week", now, "UTC").from.toISOString()).toBe("2026-03-09T00:00:00.000Z"); // 15 Mar 2026 is a Sunday
    expect(resolvePreset("this_quarter", now, "UTC").from.toISOString()).toBe("2026-01-01T00:00:00.000Z");
    expect(resolvePreset("last_year", now, "UTC").to.toISOString()).toBe("2026-01-01T00:00:00.000Z");
  });

  it("falls back to UTC for an invalid zone and parses date-only input as local midnight", () => {
    expect(resolvePreset("today", now, "Not/AZone").from.toISOString()).toBe("2026-03-15T00:00:00.000Z");
    expect(parseDateInput("2026-03-15", "Asia/Kolkata")?.toISOString()).toBe("2026-03-14T18:30:00.000Z");
    expect(parseDateInput("2026-03-15", "Asia/Kolkata", true)?.toISOString()).toBe("2026-03-15T18:30:00.000Z");
    expect(parseDateInput("garbage", "UTC")).toBeNull();
  });
});

describe("schedule maths", () => {
  it("daily/weekly/monthly next run at the local hour", () => {
    const after = new Date("2026-03-15T02:30:00Z"); // Sun 15 Mar 08:00 IST
    expect(nextRunAt({ cadence: "daily", hour: 8 }, after, "Asia/Kolkata").toISOString()).toBe("2026-03-16T02:30:00.000Z");
    expect(nextRunAt({ cadence: "daily", hour: 9 }, after, "Asia/Kolkata").toISOString()).toBe("2026-03-15T03:30:00.000Z");
    expect(nextRunAt({ cadence: "weekly", hour: 7, weekday: 1 }, after, "UTC").toISOString()).toBe("2026-03-16T07:00:00.000Z");
    expect(nextRunAt({ cadence: "monthly", hour: 6, dayOfMonth: 1 }, after, "UTC").toISOString()).toBe("2026-04-01T06:00:00.000Z");
  });

  it("keeps the local hour across DST transitions and clamps monthly day > 28", () => {
    // New York springs forward 2026-03-08 02:00 → 03:00: 08:00 local is 12:00Z (EDT), not 13:00Z (midnight + 8h in EST).
    expect(nextRunAt({ cadence: "daily", hour: 8 }, new Date("2026-03-08T00:30:00Z"), "America/New_York").toISOString()).toBe("2026-03-08T12:00:00.000Z");
    // Fall back 2026-11-01 02:00 → 01:00: 08:00 local is 13:00Z (EST), not 12:00Z.
    expect(nextRunAt({ cadence: "daily", hour: 8 }, new Date("2026-11-01T00:30:00Z"), "America/New_York").toISOString()).toBe("2026-11-01T13:00:00.000Z");
    // Quiet hours ending at 07:00 on the spring-forward day resolve to 11:00Z (EDT).
    expect(quietHoursEnd({ start: "22:00", end: "07:00" }, new Date("2026-03-08T06:30:00Z"), "America/New_York").toISOString()).toBe("2026-03-08T11:00:00.000Z");
    // dayOfMonth 31 is clamped to 28 so every month has a run; February included.
    expect(nextRunAt({ cadence: "monthly", hour: 6, dayOfMonth: 31 }, new Date("2026-01-29T00:00:00Z"), "UTC").toISOString()).toBe("2026-02-28T06:00:00.000Z");
    // Weekly on Monday after a Monday-at-hour instant goes to next week, not the same day.
    expect(nextRunAt({ cadence: "weekly", hour: 7, weekday: 1 }, new Date("2026-03-16T07:00:00Z"), "UTC").toISOString()).toBe("2026-03-23T07:00:00.000Z");
  });

  it("quiet hours wrap midnight and resolve an end instant", () => {
    const q = { start: "22:00", end: "07:00" };
    expect(inQuietHours(q, new Date("2026-03-15T23:30:00Z"), "UTC")).toBe(true);
    expect(inQuietHours(q, new Date("2026-03-15T12:00:00Z"), "UTC")).toBe(false);
    expect(inQuietHours(q, new Date("2026-03-15T23:30:00Z"), "Asia/Kolkata")).toBe(true); // 05:00 IST
    expect(quietHoursEnd(q, new Date("2026-03-15T23:30:00Z"), "UTC").toISOString()).toBe("2026-03-16T07:00:00.000Z");
    expect(inQuietHours(null, new Date(), "UTC")).toBe(false);
  });
});
