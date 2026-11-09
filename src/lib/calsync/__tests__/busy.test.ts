import { describe, expect, it } from "vitest";
import { listSlots, type SlotType } from "@/lib/calendar/slots";

const type: SlotType = { duration_minutes: 60, buffer_before: 0, buffer_after: 0, min_notice_minutes: 0, max_days_ahead: 30 };
const base = {
  rules: [{ weekday: 1, start_minute: 9 * 60, end_minute: 12 * 60 }],
  existing: [],
  blocks: [],
  type,
  from: new Date("2026-11-09T00:00:00Z"),
  to: new Date("2026-11-10T00:00:00Z"),
  now: new Date("2026-11-08T00:00:00Z"),
  timezone: "UTC",
};

describe("external busy subtraction", () => {
  it("lists all slots without busy", () => {
    expect(listSlots(base)).toEqual(["2026-11-09T09:00:00.000Z", "2026-11-09T10:00:00.000Z", "2026-11-09T11:00:00.000Z"]);
  });
  it("removes slots overlapping external busy time", () => {
    const slots = listSlots({ ...base, busy: [{ start: new Date("2026-11-09T10:30:00Z"), end: new Date("2026-11-09T11:30:00Z") }] });
    expect(slots).toEqual(["2026-11-09T09:00:00.000Z"]);
  });
});
