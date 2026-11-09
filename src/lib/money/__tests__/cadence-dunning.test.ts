import { describe, expect, it } from "vitest";
import { advanceNextRun, previewRuns } from "@/lib/money/cadence";
import { dueReminderStep, nextReminderAt, DAY_MS } from "@/lib/money/dunning";
import { computeStatement, type StatementEntry } from "@/lib/money/statements";
import { convertMinor, fxFactor } from "@/lib/money/fx";

const d = (s: string) => new Date(s);

describe("recurring cadence", () => {
  it("weekly adds 7 days per interval", () => {
    expect(advanceNextRun(d("2026-01-05T09:00:00Z"), "weekly", 2).toISOString()).toBe("2026-01-19T09:00:00.000Z");
  });

  it("monthly clamps Jan 31 to Feb 28 (non-leap) and Feb 29 (leap), then back to the 31st", () => {
    const jan31 = d("2026-01-31T09:00:00Z");
    const feb = advanceNextRun(jan31, "monthly", 1, 31);
    expect(feb.toISOString().slice(0, 10)).toBe("2026-02-28");
    expect(advanceNextRun(feb, "monthly", 1, 31).toISOString().slice(0, 10)).toBe("2026-03-31");
    expect(advanceNextRun(d("2028-01-31T09:00:00Z"), "monthly", 1, 31).toISOString().slice(0, 10)).toBe("2028-02-29");
    // Without an explicit day the anchor's day is used (and still clamped).
    expect(advanceNextRun(jan31, "monthly").toISOString().slice(0, 10)).toBe("2026-02-28");
  });

  it("quarterly and yearly roll over years", () => {
    expect(advanceNextRun(d("2026-11-15T00:00:00Z"), "quarterly").toISOString().slice(0, 10)).toBe("2027-02-15");
    expect(advanceNextRun(d("2024-02-29T00:00:00Z"), "yearly").toISOString().slice(0, 10)).toBe("2025-02-28");
  });

  it("previewRuns stops at end_at", () => {
    const runs = previewRuns(d("2026-01-31T09:00:00Z"), "monthly", 1, 31, 5, d("2026-03-31T23:59:59Z"));
    expect(runs.map((r) => r.toISOString().slice(0, 10))).toEqual(["2026-01-31", "2026-02-28", "2026-03-31"]);
  });
});

describe("dunning schedule", () => {
  const due = d("2026-03-10T00:00:00Z");
  const schedule = [-3, 0, 7, 14, 30];

  it("selects the step by elapsed days relative to due", () => {
    expect(dueReminderStep(due, d("2026-03-01T00:00:00Z"), schedule)).toBe(0);
    expect(dueReminderStep(due, d("2026-03-07T00:00:00Z"), schedule)).toBe(1); // -3
    expect(dueReminderStep(due, d("2026-03-10T00:00:00Z"), schedule)).toBe(2); // 0
    expect(dueReminderStep(due, d("2026-03-20T00:00:00Z"), schedule)).toBe(3); // +7
    expect(dueReminderStep(due, d("2027-01-01T00:00:00Z"), schedule)).toBe(5); // exhausted
  });

  it("accepts an unsorted schedule and reports the next reminder date", () => {
    expect(dueReminderStep(due, d("2026-03-17T00:00:00Z"), [30, 7, 0, -3])).toBe(3);
    expect(nextReminderAt(due, 2, schedule)?.getTime()).toBe(due.getTime() + 7 * DAY_MS);
    expect(nextReminderAt(due, 5, schedule)).toBeNull();
  });
});

describe("statement math", () => {
  const entries: StatementEntry[] = [
    { date: "2026-01-05T00:00:00Z", kind: "invoice", ref: "INV-1", description: "", currency: "USD", amount_minor: 10000, invoice_id: "i1", entity_id: "i1" },
    { date: "2026-01-20T00:00:00Z", kind: "payment", ref: "INV-1", description: "", currency: "USD", amount_minor: -4000, invoice_id: "i1", entity_id: "p1" },
    { date: "2026-02-02T00:00:00Z", kind: "invoice", ref: "INV-2", description: "", currency: "USD", amount_minor: 5000, invoice_id: "i2", entity_id: "i2" },
    { date: "2026-02-10T00:00:00Z", kind: "credit_note", ref: "CN-1", description: "", currency: "USD", amount_minor: -1000, invoice_id: "i2", entity_id: "c1" },
    { date: "2026-02-15T00:00:00Z", kind: "payment", ref: "INV-2", description: "", currency: "USD", amount_minor: -4000, invoice_id: "i2", entity_id: "p2" },
    { date: "2026-02-16T00:00:00Z", kind: "refund", ref: "INV-2", description: "", currency: "USD", amount_minor: 500, invoice_id: "i2", entity_id: "p2:refund" },
    { date: "2026-02-20T00:00:00Z", kind: "invoice", ref: "INV-3", description: "", currency: "EUR", amount_minor: 2000, invoice_id: "i3", entity_id: "i3" },
    { date: "2026-03-01T00:00:00Z", kind: "payment", ref: "INV-3", description: "", currency: "EUR", amount_minor: -2000, invoice_id: "i3", entity_id: "p3" },
  ];

  it("opening balance = everything before `from`; closing = opening + period, per currency", () => {
    const st = computeStatement(entries, d("2026-02-01T00:00:00Z"), d("2026-02-28T23:59:59Z"));
    const usd = st.balances.find((b) => b.currency === "USD");
    expect(usd).toMatchObject({ opening_minor: 6000, invoiced_minor: 5000, paid_minor: 4000, credited_minor: 1000, refunded_minor: 500, closing_minor: 6500 });
    const eur = st.balances.find((b) => b.currency === "EUR");
    expect(eur).toMatchObject({ opening_minor: 0, invoiced_minor: 2000, closing_minor: 2000 });
    expect(st.entries.filter((e) => e.currency === "USD").map((e) => e.running_minor)).toEqual([11000, 10000, 6000, 6500]);
    // March payment is after `to`: excluded from the period and from closing.
    expect(st.entries.some((e) => e.entity_id === "p3")).toBe(false);
  });

  it("all-time statement nets to the outstanding balance", () => {
    const st = computeStatement(entries, d("2020-01-01T00:00:00Z"), d("2030-01-01T00:00:00Z"));
    expect(st.balances.map((b) => [b.currency, b.closing_minor])).toEqual([["EUR", 0], ["USD", 6500]]);
  });
});

describe("fx conversion", () => {
  const rates = [
    { base: "EUR", quote: "USD", rate: "1.10", as_of: "2026-01-01T00:00:00Z" },
    { base: "EUR", quote: "USD", rate: "1.20", as_of: "2026-02-01T00:00:00Z" },
    { base: "GBP", quote: "EUR", rate: "1.15", as_of: "2026-01-01T00:00:00Z" },
  ];
  it("uses the newest direct rate, the inverse, or a pivot", () => {
    expect(convertMinor(1000, "EUR", "USD", rates)).toBe(1200);
    expect(convertMinor(1200, "USD", "EUR", rates)).toBe(1000);
    expect(fxFactor("GBP", "USD", rates)).toBeCloseTo(1.15 * 1.2, 10);
    expect(convertMinor(500, "USD", "USD", rates)).toBe(500);
    expect(convertMinor(500, "USD", "JPY", rates)).toBeNull();
  });
});
