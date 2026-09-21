import { describe, it, expect } from "vitest";
import { wouldClash, listSlots, zonedToUtc, zonedParts, groupSlotsByDay } from "@/lib/calendar/slots";

const d = (iso: string) => new Date(iso);
const type = { duration_minutes: 30, buffer_before: 0, buffer_after: 0, min_notice_minutes: 0, max_days_ahead: 30 };
const weekdayRules = [1, 2, 3, 4, 5].map((weekday) => ({ weekday, start_minute: 9 * 60, end_minute: 17 * 60 }));

describe("wouldClash", () => {
  const existing = [{ start: d("2026-03-02T10:00:00Z"), end: d("2026-03-02T10:30:00Z") }];

  it("detects direct overlap", () => {
    expect(wouldClash({ start: d("2026-03-02T10:15:00Z"), end: d("2026-03-02T10:45:00Z") }, existing)).toBe(true);
  });

  it("allows back-to-back slots without buffers", () => {
    expect(wouldClash({ start: d("2026-03-02T10:30:00Z"), end: d("2026-03-02T11:00:00Z") }, existing)).toBe(false);
    expect(wouldClash({ start: d("2026-03-02T09:30:00Z"), end: d("2026-03-02T10:00:00Z") }, existing)).toBe(false);
  });

  it("applies before/after buffers", () => {
    const c = { start: d("2026-03-02T10:30:00Z"), end: d("2026-03-02T11:00:00Z") };
    expect(wouldClash(c, existing, { before: 10, after: 0 })).toBe(true);
    expect(wouldClash(c, existing, { before: 0, after: 10 })).toBe(false);
    const before = { start: d("2026-03-02T09:30:00Z"), end: d("2026-03-02T10:00:00Z") };
    expect(wouldClash(before, existing, { before: 0, after: 15 })).toBe(true);
  });

  it("rejects zero-length candidates", () => {
    expect(wouldClash({ start: d("2026-03-02T10:00:00Z"), end: d("2026-03-02T10:00:00Z") }, [])).toBe(true);
  });
});

describe("zoned helpers", () => {
  it("maps wall clock to UTC in New York across DST", () => {
    // 2026-03-08 is DST start in the US (02:00 -> 03:00).
    expect(zonedToUtc(2026, 3, 7, 9 * 60, "America/New_York").toISOString()).toBe("2026-03-07T14:00:00.000Z");
    expect(zonedToUtc(2026, 3, 9, 9 * 60, "America/New_York").toISOString()).toBe("2026-03-09T13:00:00.000Z");
    const p = zonedParts(d("2026-03-09T13:00:00Z"), "America/New_York");
    expect(p.hour).toBe(9);
    expect(p.weekday).toBe(1);
  });
});

describe("listSlots", () => {
  it("honours weekday rules and duration in UTC", () => {
    const slots = listSlots({
      rules: [{ weekday: 1, start_minute: 9 * 60, end_minute: 10 * 60 }], // Monday 9-10
      existing: [],
      blocks: [],
      type,
      from: d("2026-03-01T00:00:00Z"), // Sunday
      to: d("2026-03-04T00:00:00Z"),
      now: d("2026-02-20T00:00:00Z"),
      timezone: "UTC",
    });
    expect(slots).toEqual(["2026-03-02T09:00:00.000Z", "2026-03-02T09:30:00.000Z"]);
  });

  it("removes slots that clash with existing bookings (with buffers)", () => {
    const slots = listSlots({
      rules: [{ weekday: 1, start_minute: 9 * 60, end_minute: 11 * 60 }],
      existing: [{ start: d("2026-03-02T09:30:00Z"), end: d("2026-03-02T10:00:00Z") }],
      blocks: [],
      type: { ...type, buffer_after: 15 },
      from: d("2026-03-02T00:00:00Z"),
      to: d("2026-03-03T00:00:00Z"),
      now: d("2026-02-20T00:00:00Z"),
      timezone: "UTC",
    });
    // 09:00 slot ends 09:30 + 15 buffer = clashes; 09:30 clashes; 10:00 ok; 10:30 ok
    expect(slots).toEqual(["2026-03-02T10:00:00.000Z", "2026-03-02T10:30:00.000Z"]);
  });

  it("removes slots inside calendar blocks", () => {
    const slots = listSlots({
      rules: [{ weekday: 1, start_minute: 9 * 60, end_minute: 10 * 60 }],
      existing: [],
      blocks: [{ start: d("2026-03-02T09:00:00Z"), end: d("2026-03-02T09:30:00Z") }],
      type,
      from: d("2026-03-02T00:00:00Z"),
      to: d("2026-03-03T00:00:00Z"),
      now: d("2026-02-20T00:00:00Z"),
      timezone: "UTC",
    });
    expect(slots).toEqual(["2026-03-02T09:30:00.000Z"]);
  });

  it("applies min notice", () => {
    const slots = listSlots({
      rules: [{ weekday: 1, start_minute: 9 * 60, end_minute: 10 * 60 }],
      existing: [],
      blocks: [],
      type: { ...type, min_notice_minutes: 60 },
      from: d("2026-03-02T00:00:00Z"),
      to: d("2026-03-03T00:00:00Z"),
      now: d("2026-03-02T08:15:00Z"),
      timezone: "UTC",
    });
    expect(slots).toEqual(["2026-03-02T09:30:00.000Z"]);
  });

  it("applies max days ahead", () => {
    const slots = listSlots({
      rules: weekdayRules,
      existing: [],
      blocks: [],
      type: { ...type, max_days_ahead: 1 },
      from: d("2026-03-02T00:00:00Z"),
      to: d("2026-03-10T00:00:00Z"),
      now: d("2026-03-02T08:00:00Z"),
      timezone: "UTC",
    });
    expect(slots.length).toBe(16); // Monday 9-17 only
    expect(slots.every((s) => s.startsWith("2026-03-02"))).toBe(true);
  });

  it("is DST-safe in America/New_York", () => {
    const tz = "America/New_York";
    const slots = listSlots({
      rules: [{ weekday: 1, start_minute: 9 * 60, end_minute: 10 * 60 }], // Mondays 9-10 local
      existing: [],
      blocks: [],
      type: { ...type, duration_minutes: 60 },
      from: d("2026-03-01T00:00:00Z"),
      to: d("2026-03-17T00:00:00Z"),
      now: d("2026-02-20T00:00:00Z"),
      timezone: tz,
    });
    // Mar 2 (EST, UTC-5) -> 14:00Z ; Mar 9 + 16 (EDT, UTC-4) -> 13:00Z
    expect(slots).toEqual(["2026-03-02T14:00:00.000Z", "2026-03-09T13:00:00.000Z", "2026-03-16T13:00:00.000Z"]);
    for (const s of slots) expect(zonedParts(new Date(s), tz).hour).toBe(9);
    const grouped = groupSlotsByDay(slots, tz);
    expect(Object.keys(grouped)).toEqual(["2026-03-02", "2026-03-09", "2026-03-16"]);
  });

  it("returns nothing when window is empty", () => {
    expect(
      listSlots({ rules: weekdayRules, existing: [], blocks: [], type, from: d("2026-03-05T00:00:00Z"), to: d("2026-03-04T00:00:00Z"), now: d("2026-03-01T00:00:00Z"), timezone: "UTC" })
    ).toEqual([]);
  });
});
