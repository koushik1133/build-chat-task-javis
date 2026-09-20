import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SCHEDULE_FIRE_WINDOW_SEC,
  TIMEZONE_OPTIONS,
  getLocalNow,
  isScheduleDue,
  msUntilNextScheduleCheck,
  type LocalNow,
  type ScheduleRow,
} from "@/lib/automation-scheduler";

/** Build a LocalNow with sensible defaults (Wed 2026-09-16 09:00:00). */
function localNow(overrides: Partial<LocalNow> = {}): LocalNow {
  return {
    date: "2026-09-16",
    time: "09:00",
    second: 0,
    weekday: 3,
    weekdayShort: "Wed",
    ...overrides,
  };
}

const baseRow: ScheduleRow = {
  schedule_time: "09:00",
  schedule_timezone: "UTC",
  schedule_days: "daily",
  last_scheduled_date: null,
};

describe("getLocalNow", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns UTC fields for a fixed instant", () => {
    // Wednesday 2026-09-16T03:30:05Z
    vi.setSystemTime(new Date("2026-09-16T03:30:05Z"));
    const now = getLocalNow("UTC");
    expect(now).toEqual({
      date: "2026-09-16",
      time: "03:30",
      second: 5,
      weekday: 3,
      weekdayShort: "Wed",
    });
  });

  it("shifts the same instant into Asia/Kolkata (+05:30)", () => {
    vi.setSystemTime(new Date("2026-09-16T03:30:05Z"));
    const now = getLocalNow("Asia/Kolkata");
    expect(now.date).toBe("2026-09-16");
    expect(now.time).toBe("09:00");
    expect(now.second).toBe(5);
    expect(now.weekdayShort).toBe("Wed");
  });

  it("rolls the date backwards for negative-offset zones", () => {
    // 03:30Z on Wed is still Tue evening in Los Angeles (PDT, -07:00)
    vi.setSystemTime(new Date("2026-09-16T03:30:05Z"));
    const now = getLocalNow("America/Los_Angeles");
    expect(now.date).toBe("2026-09-15");
    expect(now.time).toBe("20:30");
    expect(now.weekday).toBe(2);
    expect(now.weekdayShort).toBe("Tue");
  });

  it("rolls the date forwards for far-east zones", () => {
    // 22:00Z on Tue is Wed 07:00 in Tokyo (+09:00)
    vi.setSystemTime(new Date("2026-09-15T22:00:00Z"));
    const now = getLocalNow("Asia/Tokyo");
    expect(now.date).toBe("2026-09-16");
    expect(now.time).toBe("07:00");
    expect(now.weekday).toBe(3);
  });

  it("formats midnight as 00:00 rather than 24:00", () => {
    vi.setSystemTime(new Date("2026-09-16T00:00:30Z"));
    const now = getLocalNow("UTC");
    expect(now.time).toBe("00:00");
    expect(now.second).toBe(30);
  });

  it("falls back to UTC when timezone is empty", () => {
    vi.setSystemTime(new Date("2026-09-16T12:34:56Z"));
    expect(getLocalNow("")).toEqual(getLocalNow("UTC"));
  });

  it("maps every weekday name to the correct index", () => {
    // 2026-09-13 is a Sunday
    for (let i = 0; i < 7; i++) {
      vi.setSystemTime(new Date(`2026-09-${13 + i}T12:00:00Z`));
      expect(getLocalNow("UTC").weekday).toBe(i);
    }
  });
});

describe("isScheduleDue", () => {
  describe("schedule_time guards", () => {
    it("is never due without a schedule_time", () => {
      expect(isScheduleDue({ ...baseRow, schedule_time: null }, localNow())).toBe(false);
      expect(isScheduleDue({ ...baseRow, schedule_time: undefined }, localNow())).toBe(false);
      expect(isScheduleDue({ ...baseRow, schedule_time: "" }, localNow())).toBe(false);
      expect(isScheduleDue({ ...baseRow, schedule_time: "   " }, localNow())).toBe(false);
    });

    it("normalizes un-padded schedule times like 9:5", () => {
      expect(isScheduleDue({ ...baseRow, schedule_time: "9:0" }, localNow({ time: "09:00" }))).toBe(true);
      expect(isScheduleDue({ ...baseRow, schedule_time: "9:5" }, localNow({ time: "09:05" }))).toBe(true);
      expect(isScheduleDue({ ...baseRow, schedule_time: " 09:00 " }, localNow({ time: "09:00" }))).toBe(true);
    });
  });

  describe("minute and second boundaries", () => {
    it("fires at the scheduled minute within the fire window", () => {
      expect(isScheduleDue(baseRow, localNow({ second: 0 }))).toBe(true);
      expect(isScheduleDue(baseRow, localNow({ second: SCHEDULE_FIRE_WINDOW_SEC - 1 }))).toBe(true);
    });

    it("does not fire once the fire window has elapsed", () => {
      expect(isScheduleDue(baseRow, localNow({ second: SCHEDULE_FIRE_WINDOW_SEC }))).toBe(false);
      expect(isScheduleDue(baseRow, localNow({ second: 59 }))).toBe(false);
    });

    it("does not fire one minute early or late (no catch-up)", () => {
      expect(isScheduleDue(baseRow, localNow({ time: "08:59", second: 59 }))).toBe(false);
      expect(isScheduleDue(baseRow, localNow({ time: "09:01", second: 0 }))).toBe(false);
      expect(isScheduleDue(baseRow, localNow({ time: "09:46", second: 0 }))).toBe(false);
    });

    it("handles the 00:00 and 23:59 edges", () => {
      expect(isScheduleDue({ ...baseRow, schedule_time: "00:00" }, localNow({ time: "00:00" }))).toBe(true);
      expect(isScheduleDue({ ...baseRow, schedule_time: "00:00" }, localNow({ time: "23:59" }))).toBe(false);
      expect(isScheduleDue({ ...baseRow, schedule_time: "23:59" }, localNow({ time: "23:59" }))).toBe(true);
      expect(isScheduleDue({ ...baseRow, schedule_time: "23:59" }, localNow({ time: "00:00" }))).toBe(false);
    });
  });

  describe("last_scheduled_date de-duplication", () => {
    it("does not fire twice on the same local date", () => {
      expect(isScheduleDue({ ...baseRow, last_scheduled_date: "2026-09-16" }, localNow())).toBe(false);
    });

    it("fires again on a new local date", () => {
      expect(isScheduleDue({ ...baseRow, last_scheduled_date: "2026-09-15" }, localNow())).toBe(true);
    });
  });

  describe("day filters", () => {
    const sun = localNow({ date: "2026-09-13", weekday: 0, weekdayShort: "Sun" });
    const mon = localNow({ date: "2026-09-14", weekday: 1, weekdayShort: "Mon" });
    const fri = localNow({ date: "2026-09-18", weekday: 5, weekdayShort: "Fri" });
    const sat = localNow({ date: "2026-09-19", weekday: 6, weekdayShort: "Sat" });

    it("'daily' (and null/undefined) fires every day", () => {
      for (const now of [sun, mon, fri, sat]) {
        expect(isScheduleDue({ ...baseRow, schedule_days: "daily" }, now)).toBe(true);
        expect(isScheduleDue({ ...baseRow, schedule_days: null }, now)).toBe(true);
        expect(isScheduleDue({ ...baseRow, schedule_days: undefined }, now)).toBe(true);
      }
    });

    it("'weekdays' fires Mon-Fri only", () => {
      const row = { ...baseRow, schedule_days: "weekdays" };
      expect(isScheduleDue(row, mon)).toBe(true);
      expect(isScheduleDue(row, fri)).toBe(true);
      expect(isScheduleDue(row, sat)).toBe(false);
      expect(isScheduleDue(row, sun)).toBe(false);
    });

    it("a specific day key fires only on that day", () => {
      expect(isScheduleDue({ ...baseRow, schedule_days: "mon" }, mon)).toBe(true);
      expect(isScheduleDue({ ...baseRow, schedule_days: "mon" }, fri)).toBe(false);
      expect(isScheduleDue({ ...baseRow, schedule_days: "sat" }, sat)).toBe(true);
      expect(isScheduleDue({ ...baseRow, schedule_days: "sun" }, sun)).toBe(true);
      expect(isScheduleDue({ ...baseRow, schedule_days: "sun" }, sat)).toBe(false);
    });

    it("an unknown day filter falls back to daily", () => {
      expect(isScheduleDue({ ...baseRow, schedule_days: "fortnightly" }, sat)).toBe(true);
    });
  });

  describe("timezone-aware evaluation via the real clock", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("a 09:00 IST schedule is due at 03:30Z but a 09:00 UTC one is not", () => {
      vi.setSystemTime(new Date("2026-09-16T03:30:05Z"));
      expect(isScheduleDue({ ...baseRow, schedule_timezone: "Asia/Kolkata" })).toBe(true);
      expect(isScheduleDue({ ...baseRow, schedule_timezone: "UTC" })).toBe(false);
    });

    it("uses the local date of the timezone for de-duplication", () => {
      // Tue 20:30 in Los Angeles, Wed 03:30 UTC
      vi.setSystemTime(new Date("2026-09-16T03:30:05Z"));
      const row: ScheduleRow = {
        schedule_time: "20:30",
        schedule_timezone: "America/Los_Angeles",
        schedule_days: "daily",
      };
      expect(isScheduleDue({ ...row, last_scheduled_date: "2026-09-16" })).toBe(true);
      expect(isScheduleDue({ ...row, last_scheduled_date: "2026-09-15" })).toBe(false);
    });

    it("applies the weekday filter in the schedule's timezone", () => {
      // Sat 23:30 in Chicago (CDT, -05:00) == Sun 04:30 UTC
      vi.setSystemTime(new Date("2026-09-20T04:30:02Z"));
      const row: ScheduleRow = { schedule_time: "23:30", schedule_days: "weekdays" };
      expect(isScheduleDue({ ...row, schedule_timezone: "America/Chicago" })).toBe(false);
      expect(isScheduleDue({ ...row, schedule_timezone: "America/Chicago", schedule_days: "sat" })).toBe(true);
    });

    it("defaults to UTC when no timezone is stored", () => {
      vi.setSystemTime(new Date("2026-09-16T09:00:03Z"));
      expect(isScheduleDue({ schedule_time: "09:00", schedule_timezone: null })).toBe(true);
    });
  });
});

describe("msUntilNextScheduleCheck", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("counts down to a schedule later today", () => {
    vi.setSystemTime(new Date("2026-09-16T10:00:00Z"));
    expect(msUntilNextScheduleCheck("UTC", "10:30")).toBe(30 * 60 * 1000);
  });

  it("subtracts elapsed seconds in the current minute", () => {
    vi.setSystemTime(new Date("2026-09-16T10:00:15Z"));
    expect(msUntilNextScheduleCheck("UTC", "10:30")).toBe((30 * 60 - 15) * 1000);
  });

  it("wraps to tomorrow when the schedule already passed today", () => {
    vi.setSystemTime(new Date("2026-09-16T10:00:00Z"));
    expect(msUntilNextScheduleCheck("UTC", "09:00")).toBe(23 * 60 * 60 * 1000);
  });

  it("returns the 100ms floor when inside the fire window of the scheduled minute", () => {
    vi.setSystemTime(new Date("2026-09-16T10:00:00Z"));
    expect(msUntilNextScheduleCheck("UTC", "10:00")).toBe(100);
    vi.setSystemTime(new Date("2026-09-16T10:00:05Z"));
    expect(msUntilNextScheduleCheck("UTC", "10:00")).toBe(100);
  });

  it("waits a full day once the fire window in the scheduled minute has passed", () => {
    vi.setSystemTime(new Date("2026-09-16T10:00:15Z"));
    expect(msUntilNextScheduleCheck("UTC", "10:00")).toBe((24 * 60 * 60 - 15) * 1000);
  });

  it("evaluates the schedule in the given timezone", () => {
    // 03:30Z == 09:00 IST, so a 09:30 IST schedule is 30 minutes away
    vi.setSystemTime(new Date("2026-09-16T03:30:00Z"));
    expect(msUntilNextScheduleCheck("Asia/Kolkata", "09:30")).toBe(30 * 60 * 1000);
    expect(msUntilNextScheduleCheck("UTC", "09:30")).toBe(6 * 60 * 60 * 1000);
  });

  it("accepts un-padded schedule times", () => {
    vi.setSystemTime(new Date("2026-09-16T10:00:00Z"));
    expect(msUntilNextScheduleCheck("UTC", "10:5")).toBe(5 * 60 * 1000);
  });
});

describe("constants", () => {
  it("exposes a positive fire window", () => {
    expect(SCHEDULE_FIRE_WINDOW_SEC).toBeGreaterThan(0);
    expect(SCHEDULE_FIRE_WINDOW_SEC).toBeLessThan(60);
  });

  it("only lists valid IANA timezones", () => {
    for (const { value } of TIMEZONE_OPTIONS) {
      expect(() => new Intl.DateTimeFormat("en-US", { timeZone: value })).not.toThrow();
    }
    expect(TIMEZONE_OPTIONS.map((o) => o.value)).toContain("UTC");
  });
});
