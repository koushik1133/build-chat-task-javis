import { describe, expect, it } from "vitest";
import { cronMatches, isValidCron, nextRun, parseCron } from "@/lib/cron-expr";

describe("parseCron / isValidCron", () => {
  it("parses a plain 5-field expression", () => {
    const c = parseCron("30 9 * * 1-5");
    expect(c).not.toBeNull();
    expect([...c!.minute]).toEqual([30]);
    expect([...c!.hour]).toEqual([9]);
    expect([...c!.dayOfWeek].sort()).toEqual([1, 2, 3, 4, 5]);
  });

  it("expands steps and ranges", () => {
    const c = parseCron("*/15 1-3/2 * * *")!;
    expect([...c.minute]).toEqual([0, 15, 30, 45]);
    expect([...c.hour]).toEqual([1, 3]);
  });

  it("supports aliases", () => {
    expect(isValidCron("@hourly")).toBe(true);
    expect(isValidCron("@daily")).toBe(true);
    expect(isValidCron("@weekly")).toBe(true);
    expect(isValidCron("@monthly")).toBe(true);
    expect([...parseCron("@weekly")!.dayOfWeek]).toEqual([0]);
  });

  it("treats day-of-week 7 as Sunday", () => {
    expect(parseCron("0 0 * * 7")!.dayOfWeek.has(0)).toBe(true);
  });

  it("rejects invalid expressions", () => {
    expect(isValidCron("")).toBe(false);
    expect(isValidCron("* * * *")).toBe(false);
    expect(isValidCron("60 * * * *")).toBe(false);
    expect(isValidCron("* 24 * * *")).toBe(false);
    expect(isValidCron("5-1 * * * *")).toBe(false);
    expect(isValidCron("*/0 * * * *")).toBe(false);
    expect(isValidCron("a b c d e")).toBe(false);
    expect(isValidCron("@yearly")).toBe(false);
  });
});

describe("cronMatches", () => {
  it("matches in UTC", () => {
    const d = new Date("2026-09-16T09:30:00Z"); // Wednesday
    expect(cronMatches("30 9 * * 3", d)).toBe(true);
    expect(cronMatches("30 9 * * 4", d)).toBe(false);
    expect(cronMatches("31 9 * * *", d)).toBe(false);
  });

  it("respects the timezone", () => {
    const d = new Date("2026-09-16T09:30:00Z"); // 05:30 in New York (EDT)
    expect(cronMatches("30 5 * * *", d, "America/New_York")).toBe(true);
    expect(cronMatches("30 9 * * *", d, "America/New_York")).toBe(false);
    // 18:30 in Tokyo
    expect(cronMatches("30 18 * * *", d, "Asia/Tokyo")).toBe(true);
  });

  it("returns false for invalid expressions", () => {
    expect(cronMatches("nope", new Date())).toBe(false);
  });
});

describe("nextRun", () => {
  it("finds the next firing strictly after `from`", () => {
    const from = new Date("2026-09-16T09:30:00Z");
    expect(nextRun("30 9 * * *", from)?.toISOString()).toBe("2026-09-17T09:30:00.000Z");
    expect(nextRun("*/15 * * * *", from)?.toISOString()).toBe("2026-09-16T09:45:00.000Z");
  });

  it("handles timezone wall clocks", () => {
    const from = new Date("2026-09-16T00:00:00Z");
    // 09:00 New York (EDT, UTC-4) == 13:00Z
    expect(nextRun("0 9 * * *", from, "America/New_York")?.toISOString()).toBe("2026-09-16T13:00:00.000Z");
  });

  it("handles aliases and weekday constraints", () => {
    const from = new Date("2026-09-16T09:30:00Z"); // Wed
    expect(nextRun("@weekly", from)?.toISOString()).toBe("2026-09-20T00:00:00.000Z"); // Sunday
    expect(nextRun("0 0 * * 1", from)?.toISOString()).toBe("2026-09-21T00:00:00.000Z"); // Monday
  });

  it("returns null for invalid expressions", () => {
    expect(nextRun("bad", new Date())).toBeNull();
    expect(nextRun("", new Date())).toBeNull();
  });
});
