import { describe, expect, it } from "vitest";
import {
  addBusinessMinutes,
  computeDueTimes,
  effectiveMinutes,
  formatCountdown,
  nextBusinessInstant,
  parsePriorityOverrides,
  slaHealth,
  type SlaPolicyLike,
} from "@/lib/helpdesk/sla";

const calendar: SlaPolicyLike = {
  first_response_minutes: 60,
  resolution_minutes: 1440,
  business_hours_only: false,
  priority_overrides: null,
};

const business: SlaPolicyLike = { ...calendar, business_hours_only: true };

// 2026-11-02 is a Monday.
const MON_10 = new Date("2026-11-02T10:00:00Z");
const FRI_1630 = new Date("2026-11-06T16:30:00Z");
const SAT_NOON = new Date("2026-11-07T12:00:00Z");

describe("computeDueTimes — calendar time", () => {
  it("adds the policy minutes straight to createdAt", () => {
    const due = computeDueTimes(calendar, "normal", MON_10);
    expect(due.firstResponseDueAt.toISOString()).toBe("2026-11-02T11:00:00.000Z");
    expect(due.resolutionDueAt.toISOString()).toBe("2026-11-03T10:00:00.000Z");
    expect(due.firstResponseMinutes).toBe(60);
  });

  it("accepts an ISO string and rejects garbage", () => {
    expect(computeDueTimes(calendar, "low", "2026-11-02T10:00:00Z").firstResponseDueAt.toISOString()).toBe("2026-11-02T11:00:00.000Z");
    expect(() => computeDueTimes(calendar, "low", "nope")).toThrow();
  });

  it("applies priority overrides from JSON text", () => {
    const policy: SlaPolicyLike = {
      ...calendar,
      priority_overrides: JSON.stringify({ urgent: { first_response_minutes: 15, resolution_minutes: 240 }, high: { first_response_minutes: 30 } }),
    };
    const urgent = computeDueTimes(policy, "urgent", MON_10);
    expect(urgent.firstResponseDueAt.toISOString()).toBe("2026-11-02T10:15:00.000Z");
    expect(urgent.resolutionDueAt.toISOString()).toBe("2026-11-02T14:00:00.000Z");
    const high = computeDueTimes(policy, "high", MON_10);
    expect(high.firstResponseMinutes).toBe(30);
    expect(high.resolutionMinutes).toBe(1440); // falls back to policy default
    expect(computeDueTimes(policy, "low", MON_10).firstResponseMinutes).toBe(60);
  });
});

describe("computeDueTimes — business hours (Mon–Fri 09:00–17:00 UTC)", () => {
  it("counts only business minutes within a day", () => {
    const due = computeDueTimes(business, "normal", MON_10);
    expect(due.firstResponseDueAt.toISOString()).toBe("2026-11-02T11:00:00.000Z");
  });

  it("rolls past 17:00 into the next business morning", () => {
    // Friday 16:30 + 60 business minutes = 30 min Friday, 30 min Monday → Mon 09:30.
    const due = computeDueTimes(business, "normal", FRI_1630);
    expect(due.firstResponseDueAt.toISOString()).toBe("2026-11-09T09:30:00.000Z");
  });

  it("skips weekends entirely and starts the clock Monday 09:00", () => {
    const due = computeDueTimes(business, "normal", SAT_NOON);
    expect(due.firstResponseDueAt.toISOString()).toBe("2026-11-09T10:00:00.000Z");
  });

  it("spreads a 24h resolution target across three business days", () => {
    // 1440 min = 3 × 480. Mon 10:00 → Mon 7h, Tue 8h, Wed 8h, Thu 1h → Thu 10:00.
    const due = computeDueTimes(business, "normal", MON_10);
    expect(due.resolutionDueAt.toISOString()).toBe("2026-11-05T10:00:00.000Z");
  });

  it("moves a before-hours start to 09:00 the same day", () => {
    expect(nextBusinessInstant(new Date("2026-11-03T06:15:00Z")).toISOString()).toBe("2026-11-03T09:00:00.000Z");
    expect(addBusinessMinutes(new Date("2026-11-03T06:15:00Z"), 30).toISOString()).toBe("2026-11-03T09:30:00.000Z");
  });
});

describe("parsePriorityOverrides / effectiveMinutes", () => {
  it("tolerates invalid JSON, non-objects and bad numbers", () => {
    expect(parsePriorityOverrides("not json")).toEqual({});
    expect(parsePriorityOverrides("[1,2]")).toEqual({});
    expect(parsePriorityOverrides(null)).toEqual({});
    expect(parsePriorityOverrides(JSON.stringify({ urgent: { first_response_minutes: -5, resolution_minutes: "90" } }))).toEqual({
      urgent: { resolution_minutes: 90 },
    });
  });

  it("falls back to sane defaults when the policy has junk values", () => {
    const m = effectiveMinutes({ first_response_minutes: 0, resolution_minutes: Number.NaN, business_hours_only: false }, "normal");
    expect(m).toEqual({ first: 60, resolution: 1440 });
  });
});

describe("slaHealth / formatCountdown", () => {
  const now = new Date("2026-11-02T12:00:00Z");
  it("classifies due times", () => {
    expect(slaHealth(null, null, now)).toBe("none");
    expect(slaHealth("2026-11-02T13:00:00Z", "2026-11-02T12:30:00Z", now)).toBe("met");
    expect(slaHealth("2026-11-02T11:00:00Z", null, now)).toBe("breached");
    expect(slaHealth("2026-11-02T12:20:00Z", null, now)).toBe("warning");
    expect(slaHealth("2026-11-02T18:00:00Z", null, now)).toBe("ok");
    // 25% of a 24h window = 6h → 5h left is a warning.
    expect(slaHealth("2026-11-02T17:00:00Z", null, now, 1440)).toBe("warning");
  });
  it("formats countdowns with a sign", () => {
    expect(formatCountdown("2026-11-02T14:15:00Z", now)).toBe("2h 15m");
    expect(formatCountdown("2026-11-02T11:15:00Z", now)).toBe("-45m");
    expect(formatCountdown("2026-11-04T13:00:00Z", now)).toBe("2d 1h");
  });
});
