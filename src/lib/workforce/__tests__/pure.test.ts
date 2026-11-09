import { describe, expect, it } from "vitest";
import {
  attendanceMinutes,
  bucketByDay,
  defaultLeaveHours,
  findShiftConflicts,
  localMidnightUtc,
  payrollLine,
  periodWeeks,
  remainingHours,
  shiftMinutes,
  weekDays,
  weekStartOf,
  weekdaysBetween,
} from "../pure";
import { capacityPlan } from "@/lib/optimize/capacity";

const staff = { id: "s1", display_name: "Ana", role_title: "Tech", employment_type: "full_time" as const, hourly_rate_minor: 2000, currency: "USD", weekly_hours: 40 };

describe("shift arithmetic", () => {
  it("subtracts the break and never goes negative", () => {
    expect(shiftMinutes("2026-03-02T09:00:00Z", "2026-03-02T17:00:00Z", 30)).toBe(450);
    expect(shiftMinutes("2026-03-02T09:00:00Z", "2026-03-02T09:10:00Z", 30)).toBe(0);
    expect(shiftMinutes("2026-03-02T17:00:00Z", "2026-03-02T09:00:00Z")).toBe(0);
  });
  it("attendance minutes: null while open, 0 when inverted", () => {
    expect(attendanceMinutes("2026-03-02T09:00:00Z", null)).toBeNull();
    expect(attendanceMinutes("2026-03-02T09:00:00Z", "2026-03-02T12:30:00Z")).toBe(210);
    expect(attendanceMinutes("2026-03-02T09:00:00Z", "2026-03-02T08:00:00Z")).toBe(0);
  });
});

describe("conflict detection", () => {
  const existing = [
    { id: "a", staff_id: "s1", starts_at: "2026-03-02T09:00:00Z", ends_at: "2026-03-02T13:00:00Z", status: "published" },
    { id: "c", staff_id: "s1", starts_at: "2026-03-02T14:00:00Z", ends_at: "2026-03-02T18:00:00Z", status: "cancelled" },
    { id: "b", staff_id: "s2", starts_at: "2026-03-02T09:00:00Z", ends_at: "2026-03-02T13:00:00Z", status: "published" },
  ];
  const leave = [{ id: "l1", staff_id: "s1", starts_on: "2026-03-05", ends_on: "2026-03-06", status: "approved" }];

  it("flags an overlapping live shift for the same person only", () => {
    const c = findShiftConflicts({ staff_id: "s1", starts_at: "2026-03-02T12:00:00Z", ends_at: "2026-03-02T16:00:00Z" }, existing, leave);
    expect(c.map((x) => x.kind)).toEqual(["shift_overlap"]);
    expect(c[0].shift_id).toBe("a");
  });
  it("adjacent shifts (end == start) do not conflict; cancelled shifts are ignored; the shift itself is excluded", () => {
    expect(findShiftConflicts({ staff_id: "s1", starts_at: "2026-03-02T13:00:00Z", ends_at: "2026-03-02T17:00:00Z" }, existing, leave)).toEqual([]);
    expect(findShiftConflicts({ id: "a", staff_id: "s1", starts_at: "2026-03-02T09:30:00Z", ends_at: "2026-03-02T13:00:00Z" }, existing, leave)).toEqual([]);
  });
  it("flags approved leave on any local day the shift touches, in the org timezone", () => {
    // 2026-03-04 23:00 UTC is already 2026-03-05 in Europe/Berlin → on leave there, not in UTC.
    const cand = { staff_id: "s1", starts_at: "2026-03-04T23:00:00Z", ends_at: "2026-03-04T23:30:00Z" };
    expect(findShiftConflicts(cand, [], leave, "UTC")).toEqual([]);
    expect(findShiftConflicts(cand, [], leave, "Europe/Berlin").map((c) => c.kind)).toEqual(["on_leave"]);
  });
  it("open shifts never conflict", () => {
    expect(findShiftConflicts({ staff_id: null, starts_at: "2026-03-02T09:00:00Z", ends_at: "2026-03-02T17:00:00Z" }, existing, leave)).toEqual([]);
  });
});

describe("week bucketing with timezone", () => {
  it("weekStartOf is Monday and weekDays spans seven days", () => {
    expect(weekStartOf("2026-03-04")).toBe("2026-03-02"); // Wednesday → Monday
    expect(weekStartOf("2026-03-01")).toBe("2026-02-23"); // Sunday → previous Monday
    expect(weekDays("2026-03-02")).toEqual(["2026-03-02", "2026-03-03", "2026-03-04", "2026-03-05", "2026-03-06", "2026-03-07", "2026-03-08"]);
  });
  it("buckets by the local day: a late-UTC shift lands on the next day in Asia/Kolkata and is dropped outside the week", () => {
    const items = [
      { id: "x", starts_at: "2026-03-02T20:00:00Z" }, // 01:30 on Mar 3 IST
      { id: "y", starts_at: "2026-03-08T19:00:00Z" }, // 00:30 on Mar 9 IST → outside the week
      { id: "z", starts_at: "2026-03-02T03:00:00Z" },
    ];
    const utc = bucketByDay(items, "2026-03-02", "UTC");
    const ist = bucketByDay(items, "2026-03-02", "Asia/Kolkata");
    expect(utc["2026-03-02"].map((i) => i.id)).toEqual(["z", "x"]);
    expect(utc["2026-03-08"].map((i) => i.id)).toEqual(["y"]);
    expect(ist["2026-03-02"].map((i) => i.id)).toEqual(["z"]);
    expect(ist["2026-03-03"].map((i) => i.id)).toEqual(["x"]);
    expect(ist["2026-03-08"]).toEqual([]);
  });
  it("localMidnightUtc handles DST (America/New_York, spring forward)", () => {
    expect(localMidnightUtc("2026-03-07", "America/New_York").toISOString()).toBe("2026-03-07T05:00:00.000Z");
    expect(localMidnightUtc("2026-03-09", "America/New_York").toISOString()).toBe("2026-03-09T04:00:00.000Z");
  });
});

describe("leave balance math", () => {
  it("counts weekdays and derives default hours from the contracted week", () => {
    expect(weekdaysBetween("2026-03-02", "2026-03-08")).toBe(5);
    expect(weekdaysBetween("2026-03-07", "2026-03-08")).toBe(0);
    expect(defaultLeaveHours("2026-03-02", "2026-03-03", 40)).toBe(16);
    expect(defaultLeaveHours("2026-03-02", "2026-03-02", 20)).toBe(4);
    expect(defaultLeaveHours("2026-03-07", "2026-03-08", 40)).toBe(0);
  });
  it("remaining never goes negative", () => {
    expect(remainingHours({ allotted_hours: 80, used_hours: 24 })).toBe(56);
    expect(remainingHours({ allotted_hours: 10, used_hours: 24 })).toBe(0);
  });
});

describe("payroll", () => {
  it("pays regular + paid leave at rate and overtime above weekly_hours × weeks at 1.5×", () => {
    const line = payrollLine({ staff, scheduledMinutes: 40 * 60, attendedMinutes: 45 * 60, paidLeaveHours: 8, unpaidLeaveHours: 4, periodWeeks: 1 });
    expect(line.regular_hours).toBe(40);
    expect(line.overtime_hours).toBe(5);
    expect(line.variance_hours).toBe(5);
    // 40h × $20 + 8h leave × $20 + 5h × $30 = 800 + 160 + 150 = $1,110
    expect(line.gross_minor).toBe(111_000);
    expect(line.unpaid_leave_hours).toBe(4);
  });
  it("prorates the overtime threshold by period length and contractors never accrue overtime", () => {
    const twoWeeks = payrollLine({ staff, scheduledMinutes: 0, attendedMinutes: 85 * 60, paidLeaveHours: 0, unpaidLeaveHours: 0, periodWeeks: 2 });
    expect(twoWeeks.overtime_hours).toBe(5);
    const contractor = payrollLine({ staff: { ...staff, employment_type: "contractor" }, scheduledMinutes: 0, attendedMinutes: 85 * 60, paidLeaveHours: 0, unpaidLeaveHours: 0, periodWeeks: 1 });
    expect(contractor.overtime_hours).toBe(0);
    expect(contractor.gross_minor).toBe(85 * 2000);
  });
  it("periodWeeks is inclusive", () => {
    expect(periodWeeks("2026-03-02", "2026-03-08")).toBe(1);
    expect(periodWeeks("2026-03-01", "2026-03-31")).toBeCloseTo(31 / 7);
  });
});

describe("capacity adapter", () => {
  it("uses shifts as supply for weeks that have them and keeps the rule estimate elsewhere", () => {
    const now = new Date("2026-03-04T12:00:00Z");
    const members = [{ id: "s1", label: "Ana" }, { id: "s2", label: "Ben" }];
    const base = capacityPlan({ bookings: [], availability: [{ weekday: 1, start_minute: 540, end_minute: 1020 }], timeEntries: [], members }, { now, weeks: 2, lookbackWeeks: 1 });
    const withShifts = capacityPlan(
      { bookings: [], availability: [{ weekday: 1, start_minute: 540, end_minute: 1020 }], timeEntries: [], members, shifts: [{ id: "x", member_id: "s1", starts_at: "2026-03-09T09:00:00Z", ends_at: "2026-03-09T17:00:00Z", minutes: 450 }] },
      { now, weeks: 2, lookbackWeeks: 1 }
    );
    const thisWeek = withShifts.weeks.find((w) => w.weekStart === "2026-03-02")!;
    const nextWeek = withShifts.weeks.find((w) => w.weekStart === "2026-03-09")!;
    expect(thisWeek.availableMinutes).toBe(base.weeks.find((w) => w.weekStart === "2026-03-02")!.availableMinutes);
    expect(nextWeek.availableMinutes).toBe(450);
    const ana = withShifts.members.find((m) => m.id === "s1")!.weeks.find((w) => w.weekStart === "2026-03-09")!;
    const ben = withShifts.members.find((m) => m.id === "s2")!.weeks.find((w) => w.weekStart === "2026-03-09")!;
    expect(ana.availableMinutes).toBe(450);
    expect(ben.availableMinutes).toBe(0);
  });
});
