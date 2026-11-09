import { describe, expect, it } from "vitest";
import { capacityPlan } from "../capacity";

describe("capacityPlan: project task estimates as demand", () => {
  const now = new Date("2026-03-10T12:00:00Z"); // Tuesday; week of Mon 2026-03-09
  const base = { bookings: [], availability: [], timeEntries: [], members: [{ id: "m1", label: "Ana" }] };
  it("books a dated estimate in its due week and attributes it to the member", () => {
    const plan = capacityPlan({ ...base, taskEstimates: [{ id: "t", estimate_minutes: 600, due_at: "2026-03-18T17:00:00Z", member_id: "m1" }] }, { now, weeks: 4, lookbackWeeks: 1 });
    const week = plan.weeks.find((w) => w.weekStart === "2026-03-16")!;
    expect(week.bookedMinutes).toBe(600);
    expect(plan.weeks.find((w) => w.weekStart === "2026-03-09")!.bookedMinutes).toBe(0);
    const member = plan.members.find((m) => m.id === "m1")!;
    expect(member.weeks.find((w) => w.weekStart === "2026-03-16")!.bookedMinutes).toBe(600);
  });
  it("spreads an undated estimate across future weeks and lands late ones in the current week", () => {
    const plan = capacityPlan({ ...base, taskEstimates: [{ id: "a", estimate_minutes: 400, due_at: null, member_id: null }, { id: "b", estimate_minutes: 90, due_at: "2026-02-01T00:00:00Z", member_id: null }] }, { now, weeks: 4, lookbackWeeks: 1 });
    const future = plan.weeks.filter((w) => !w.past);
    expect(future.length).toBe(4);
    expect(future[0].bookedMinutes).toBe(190); // 100 share + 90 late
    expect(future[1].bookedMinutes).toBe(100);
  });
  it("is a no-op without estimates", () => {
    const a = capacityPlan(base, { now, weeks: 2 });
    const b = capacityPlan({ ...base, taskEstimates: [] }, { now, weeks: 2 });
    expect(a.weeks.map((w) => w.bookedMinutes)).toEqual(b.weeks.map((w) => w.bookedMinutes));
  });
});
