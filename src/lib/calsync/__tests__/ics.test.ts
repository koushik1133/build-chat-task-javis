import { describe, expect, it } from "vitest";
import { bookingSummary, buildIcs, escapeIcsText, foldLine, icsDate, icsUid } from "../ics";

describe("ics builder", () => {
  it("escapes text values", () => {
    expect(escapeIcsText("a,b;c\\d\ne")).toBe("a\\,b\;c\\\\d\\ne");
  });
  it("formats UTC dates", () => {
    expect(icsDate("2026-11-10T15:00:00.000Z")).toBe("20261110T150000Z");
  });
  it("folds at 75 octets, including multibyte characters", () => {
    const folded = foldLine("SUMMARY:" + "x".repeat(200));
    const lines = folded.split("\r\n");
    expect(lines.length).toBeGreaterThan(2);
    for (const [i, l] of lines.entries()) {
      expect(new TextEncoder().encode(l).length).toBeLessThanOrEqual(75);
      if (i > 0) expect(l.startsWith(" ")).toBe(true);
    }
    expect(folded.replace(/\r\n /g, "")).toBe("SUMMARY:" + "x".repeat(200));
    const multi = foldLine("SUMMARY:" + "é".repeat(100));
    for (const l of multi.split("\r\n")) expect(new TextEncoder().encode(l).length).toBeLessThanOrEqual(75);
    expect(multi.replace(/\r\n /g, "")).toBe("SUMMARY:" + "é".repeat(100));
  });
  it("builds a stable VCALENDAR with first-name-only titles", () => {
    const ev = { id: "b1", summary: bookingSummary("Ada Lovelace"), startsAt: "2026-11-10T15:00:00Z", endsAt: "2026-11-10T15:30:00Z" };
    const now = new Date("2026-11-01T00:00:00Z");
    const a = buildIcs([ev], { name: "Cal", now });
    const b = buildIcs([ev], { name: "Cal", now });
    expect(a).toBe(b);
    expect(a).toContain("BEGIN:VCALENDAR\r\n");
    expect(a).toContain(`UID:${icsUid("b1")}`);
    expect(a).toContain("DTSTART:20261110T150000Z");
    expect(a).toContain("SUMMARY:Appointment: Ada");
    expect(a).not.toContain("Lovelace");
    expect(a).not.toContain("VTIMEZONE");
    expect(a.endsWith("END:VCALENDAR\r\n")).toBe(true);
  });
});
