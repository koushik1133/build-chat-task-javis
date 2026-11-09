import { describe, expect, it } from "vitest";
import { assertCrewLeaveRange, CREW_LEAVE_MAX_DAYS, CrewActionError } from "@/lib/crew";

const now = new Date("2026-11-09T12:00:00Z");

describe("assertCrewLeaveRange (SEC: crew links file bounded leave only)", () => {
  it("accepts a normal range", () => {
    expect(() => assertCrewLeaveRange("2026-11-20", "2026-11-24", now)).not.toThrow();
    expect(() => assertCrewLeaveRange("2026-11-20", "2026-11-20", now)).not.toThrow();
  });

  it("rejects impossible calendar dates, inverted ranges and absurd spans", () => {
    const err = (a: string, b: string) => {
      try {
        assertCrewLeaveRange(a, b, now);
      } catch (e) {
        return e;
      }
      return null;
    };
    expect(err("2026-99-99", "2026-99-99")).toBeInstanceOf(CrewActionError);
    expect((err("2026-11-20", "2026-11-19") as CrewActionError).status).toBe(400);
    expect((err("2026-01-01", "9999-12-31") as CrewActionError).message).toMatch(new RegExp(String(CREW_LEAVE_MAX_DAYS)));
    expect((err("2030-01-01", "2030-01-02") as CrewActionError).message).toMatch(/two years/);
    expect((err("2020-01-01", "2020-01-02") as CrewActionError).message).toMatch(/past/);
  });
});
