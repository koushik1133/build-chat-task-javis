import { describe, expect, it } from "vitest";
import { cashflowForecast, daysToPay, detectRecurring, weekStartUtc, isoDate } from "@/lib/optimize/cashflow";
import { capacityPlan, weeklyMinutes } from "@/lib/optimize/capacity";
import { pricingSuggestion, similarity, outcome } from "@/lib/optimize/pricing";
import { aggregateRollup } from "@/lib/agency/rollup";

const NOW = new Date("2026-11-04T10:00:00Z"); // a Wednesday
const d = (days: number) => new Date(NOW.getTime() + days * 86_400_000).toISOString();

describe("cashflowForecast", () => {
  it("starts weeks on Monday (UTC)", () => {
    expect(isoDate(weekStartUtc(NOW))).toBe("2026-11-02");
    expect(isoDate(weekStartUtc(new Date("2026-11-01T23:00:00Z")))).toBe("2026-10-26");
  });

  it("derives days-to-pay per contact and overall from paid invoices", () => {
    const { byContact, overall } = daysToPay([
      { id: "a", contact_id: "c1", status: "paid", total_minor: 100, paid_minor: 100, due_at: null, sent_at: d(-30), created_at: d(-31), paid_at: d(-10) },
      { id: "b", contact_id: "c1", status: "paid", total_minor: 100, paid_minor: 100, due_at: null, sent_at: d(-60), created_at: d(-61), paid_at: d(-50) },
      { id: "c", contact_id: "c2", status: "paid", total_minor: 100, paid_minor: 100, due_at: null, sent_at: null, created_at: d(-40), paid_at: d(-38) },
      { id: "d", contact_id: null, status: "sent", total_minor: 100, paid_minor: 0, due_at: d(5), sent_at: d(-1), created_at: d(-1), paid_at: null },
    ]);
    expect(byContact.get("c1")).toBe(15);
    expect(byContact.get("c2")).toBe(2);
    expect(overall).toBe(10);
  });

  it("detects steady recurring expenses and ignores irregular ones", () => {
    const { recurring, recurringIds } = detectRecurring(
      [
        { id: "r1", vendor: "Adobe", category: "software", amount_minor: 5_000, spent_at: d(-90) },
        { id: "r2", vendor: "Adobe", category: "software", amount_minor: 5_000, spent_at: d(-60) },
        { id: "r3", vendor: "adobe ", category: "software", amount_minor: 5_200, spent_at: d(-30) },
        { id: "x1", vendor: "Hardware store", category: "materials", amount_minor: 9_000, spent_at: d(-80) },
        { id: "x2", vendor: "Hardware store", category: "materials", amount_minor: 1_000, spent_at: d(-70) },
        { id: "x3", vendor: "Hardware store", category: "materials", amount_minor: 4_000, spent_at: d(-3) },
      ],
      NOW
    );
    expect(recurring).toHaveLength(1);
    expect(recurring[0]).toMatchObject({ everyDays: 30, amount_minor: 5000, occurrences: 3 });
    expect(new Date(recurring[0].nextAt).getTime()).toBeGreaterThanOrEqual(NOW.getTime() - 86_400_000);
    expect(recurringIds.has("r1")).toBe(true);
    expect(recurringIds.has("x1")).toBe(false);
  });

  it("places receivables by due date + lateness, weights the pipeline by stage and flags risk", () => {
    const f = cashflowForecast(
      {
        invoices: [
          // c1 historically pays 24 days after issue → 10 days late vs the 14-day default
          { id: "h", contact_id: "c1", status: "paid", total_minor: 100_000, paid_minor: 100_000, due_at: null, sent_at: d(-50), created_at: d(-50), paid_at: d(-26) },
          { id: "o1", number: "INV-1", contact_id: "c1", status: "sent", total_minor: 100_000, paid_minor: 0, due_at: d(7), sent_at: d(-7), created_at: d(-7), paid_at: null },
          { id: "o2", number: "INV-2", contact_id: "c2", status: "overdue", total_minor: 40_000, paid_minor: 10_000, due_at: d(-10), sent_at: d(-40), created_at: d(-40), paid_at: null },
        ],
        expenses: [
          { id: "e1", vendor: "Rent", category: "rent", amount_minor: 60_000, spent_at: d(-61) },
          { id: "e2", vendor: "Rent", category: "rent", amount_minor: 60_000, spent_at: d(-31) },
          { id: "e3", vendor: "Rent", category: "rent", amount_minor: 60_000, spent_at: d(-1) },
          { id: "e4", vendor: null, category: "fuel", amount_minor: 7_000, spent_at: d(-20) },
        ],
        quotes: [
          { id: "q1", status: "viewed", total_minor: 50_000, valid_until: d(10), created_at: d(-5), contact_id: null },
          { id: "q2", status: "sent", total_minor: 50_000, valid_until: d(-1), created_at: d(-40), contact_id: null }, // expired → ignored
        ],
        bookings: [{ id: "b1", status: "confirmed", starts_at: d(3), price_minor: 20_000 }],
      },
      { weeks: 8, now: NOW, openingBalance: 0 }
    );
    expect(f.weeks).toHaveLength(8);
    expect(f.weeks[0].weekStart).toBe("2026-11-02");
    // INV-1 due in 7 days + 10 days lateness = 17 days → week index 2 (Nov 16–22).
    const inv1Week = f.weeks.find((w) => w.inflowConfirmed >= 100_000);
    expect(inv1Week?.weekStart).toBe("2026-11-16");
    // Overdue INV-2 remaining 30 000 is expected within a short window (current/next week).
    const totalConfirmed = f.weeks.reduce((s, w) => s + w.inflowConfirmed, 0);
    expect(totalConfirmed).toBe(130_000);
    expect(f.summary.receivablesOpen).toBe(130_000);
    expect(f.summary.receivablesOverdue).toBe(30_000);
    // Pipeline: viewed quote 50 000 × 0.6 + booking 20 000 × 0.9; expired quote ignored.
    expect(f.summary.totalInflowExpected).toBe(30_000 + 18_000);
    expect(f.summary.pipelineGross).toBe(70_000);
    // Rent recurs every 30 days; fuel is run-rate.
    expect(f.assumptions.recurring[0]).toMatchObject({ label: "Rent", everyDays: 30 });
    expect(f.assumptions.weeklyRunRate).toBeGreaterThan(0);
    expect(f.weeks.reduce((s, w) => s + w.outflowRecurring, 0)).toBeGreaterThanOrEqual(60_000);
    // Nothing in the bank and run-rate spend in week one → confirmed balance dips below zero immediately.
    const neg = f.risks.find((r) => r.kind === "negative_balance");
    expect(neg?.weekStart).toBe("2026-11-02");
    expect(f.weeks[0].balanceConfirmed).toBeLessThan(0);
    expect(f.risks.some((r) => r.kind === "overdue_receivables")).toBe(true);
    expect(f.risks.some((r) => r.kind === "concentration")).toBe(true); // c1 owes 77%
    // Balances are cumulative and consistent.
    const last = f.weeks[f.weeks.length - 1];
    expect(last.balance).toBe(f.summary.endingBalance);
    expect(last.balanceConfirmed).toBe(f.summary.endingBalanceConfirmed);
    expect(f.summary.endingBalance - f.summary.endingBalanceConfirmed).toBe(f.summary.totalInflowExpected);
  });

  it("returns a no_data flag on empty input and clamps the horizon", () => {
    const f = cashflowForecast({ invoices: [], expenses: [], quotes: [], bookings: [] }, { weeks: 99, now: NOW });
    expect(f.weeks).toHaveLength(52);
    expect(f.risks[0].kind).toBe("no_data");
    expect(f.summary.endingBalance).toBe(0);
  });
});

describe("capacityPlan", () => {
  const rules = [1, 2, 3, 4, 5].map((weekday) => ({ weekday, start_minute: 9 * 60, end_minute: 17 * 60 }));

  it("sums weekly availability from rules", () => {
    expect(weeklyMinutes(rules)).toBe(40 * 60);
  });

  it("computes utilisation per week and per member and finds bottlenecks", () => {
    const plan = capacityPlan(
      {
        availability: rules,
        members: [
          { id: "m1", label: "Ana" },
          { id: "m2", label: "Bo" },
        ],
        // 2 people × 40h = 80h available. Next week has 75h booked → 94% → bottleneck.
        bookings: [
          { id: "b1", status: "confirmed", starts_at: "2026-11-09T09:00:00Z", ends_at: "2026-11-09T19:00:00Z", member_id: "m1" }, // 10h
          { id: "b2", status: "confirmed", starts_at: "2026-11-10T00:00:00Z", ends_at: "2026-11-12T17:00:00Z", member_id: "m2" }, // 65h
          { id: "b3", status: "cancelled", starts_at: "2026-11-16T09:00:00Z", ends_at: "2026-11-16T17:00:00Z" },
          { id: "b4", status: "confirmed", starts_at: "2026-11-17T09:00:00Z", ends_at: "2026-11-17T13:00:00Z" }, // 4h
        ],
        timeEntries: [
          { id: "t1", member_id: "m1", started_at: "2026-10-27T09:00:00Z", minutes: 600 }, // last week, 10h
          { id: "t2", member_id: "m1", started_at: "2026-10-28T09:00:00Z", minutes: 600, ref_kind: "booking" }, // already booked → ignored
        ],
      },
      { weeks: 4, lookbackWeeks: 2, now: NOW }
    );
    expect(plan.people).toBe(2);
    expect(plan.weeks).toHaveLength(6);
    expect(plan.weeks.filter((w) => w.past)).toHaveLength(2);
    // Baseline unscheduled work: 10h logged over 2 look-back weeks → 300 min/week.
    expect(plan.baselineLoggedMinutes).toBe(300);
    const next = plan.weeks.find((w) => w.weekStart === "2026-11-09")!;
    expect(next.bookedMinutes).toBe(75 * 60);
    expect(next.demandMinutes).toBe(75 * 60 + 300);
    expect(next.bottleneck).toBe(true);
    expect(plan.bottleneckWeeks).toEqual(["2026-11-09"]);
    const wk17 = plan.weeks.find((w) => w.weekStart === "2026-11-16")!;
    expect(wk17.bookedMinutes).toBe(240);
    expect(wk17.bottleneck).toBe(false);
    // Per member: Bo has 65h booked in a 40h week.
    const bo = plan.members.find((m) => m.id === "m2")!;
    expect(bo.weeks.find((w) => w.weekStart === "2026-11-09")!.utilisation).toBeGreaterThan(1);
    const ana = plan.members.find((m) => m.id === "m1")!;
    expect(ana.weeks.find((w) => w.weekStart === "2026-10-26")!.loggedMinutes).toBe(600);
    // One isolated over-target week → extra hours, not a hire.
    expect(plan.suggestion.kind).toBe("extra_hours");
    expect(plan.suggestion.extraHoursPerWeek).toBeGreaterThan(0);
  });

  it("recommends a hire when the overload is sustained, and flags no data / underuse", () => {
    const booked = Array.from({ length: 4 }, (_, i) => ({
      id: `b${i}`,
      status: "confirmed",
      starts_at: new Date(Date.UTC(2026, 10, 9 + i * 7, 0)).toISOString(),
      ends_at: new Date(Date.UTC(2026, 10, 9 + i * 7 + 2, 12)).toISOString(), // 60h each week, 1 person → 150%
    }));
    const plan = capacityPlan({ availability: rules, members: [{ id: "m1", label: "Solo" }], bookings: booked, timeEntries: [] }, { weeks: 4, lookbackWeeks: 1, now: NOW });
    expect(plan.suggestion.kind).toBe("hire");
    expect(plan.suggestion.hires).toBeGreaterThanOrEqual(1);

    const empty = capacityPlan({ availability: [], members: [], bookings: [], timeEntries: [] }, { now: NOW });
    expect(empty.people).toBe(1);
    expect(empty.weeklyMinutesPerPerson).toBe(2400);
    expect(empty.suggestion.kind).toBe("no_data");

    const light = capacityPlan({ availability: rules, members: [{ id: "m1", label: "Solo" }], bookings: [booked[0]], timeEntries: [{ id: "t", member_id: "m1", started_at: "2026-10-28T09:00:00Z", minutes: 60 }] }, { weeks: 8, lookbackWeeks: 1, now: NOW });
    expect(["underused", "extra_hours", "ok"]).toContain(light.suggestion.kind);
  });
});

describe("pricingSuggestion", () => {
  it("matches descriptions on content tokens", () => {
    expect(similarity("Website design (5 pages)", "website design - 5 page")).toBeGreaterThanOrEqual(0.5);
    expect(similarity("SEO audit", "Monthly SEO retainer")).toBeLessThan(0.5);
    expect(similarity("Logo", "Logo design")).toBeGreaterThanOrEqual(0.5);
    expect(outcome("accepted")).toBe("won");
    expect(outcome("expired")).toBe("lost");
    expect(outcome("sent")).toBeNull();
  });

  it("builds win-rate bands and suggests the best expected-value range", () => {
    const hist = (status: string, price: number, id: string) => ({ id, status, items: [{ description: "Website design", qty: 1, unit_minor: price }] });
    const history = [
      hist("accepted", 200_000, "a1"), hist("accepted", 210_000, "a2"), hist("accepted", 250_000, "a3"), hist("declined", 260_000, "d1"),
      hist("accepted", 300_000, "a4"), hist("declined", 320_000, "d2"), hist("declined", 400_000, "d3"), hist("expired", 450_000, "d4"),
      { id: "s1", status: "sent", items: [{ description: "Website design", qty: 1, unit_minor: 999_999 }] }, // undecided → ignored
    ];
    const s = pricingSuggestion([{ description: "website design", qty: 1, unit_minor: 420_000 }, { description: "Hosting", qty: 12, unit_minor: 2_000 }], history);
    expect(s.overall).toEqual({ quotes: 8, won: 4, lost: 4, winRate: 0.5 });
    const web = s.items[0];
    expect(web.basis).toBe("history");
    expect(web.matches).toBe(8);
    expect(web.bands).toHaveLength(4);
    expect(web.bands[0]).toMatchObject({ min_minor: 200_000, max_minor: 210_000, won: 2, lost: 0, winRate: 1 });
    expect(web.bands[3]).toMatchObject({ min_minor: 400_000, max_minor: 450_000, winRate: 0 });
    // Current 420 000 sits in the losing band.
    expect(web.expectedWinProbability).toBe(0);
    expect(web.suggested_min_minor).toBeLessThan(420_000);
    expect(web.suggestedWinProbability).toBeGreaterThan(0);
    expect(web.suggested_unit_minor).toBeGreaterThanOrEqual(web.suggested_min_minor!);
    expect(web.suggested_unit_minor).toBeLessThanOrEqual(web.suggested_max_minor!);
    expect(web.expectedValueDelta_minor).toBeGreaterThan(0);
    expect(web.note).toMatch(/above/);
    const hosting = s.items[1];
    expect(hosting.basis).toBe("insufficient");
    expect(hosting.expectedWinProbability).toBe(0.5);
    expect(hosting.suggested_unit_minor).toBeNull();
  });
});

describe("agency rollup aggregation", () => {
  it("folds per-table aggregates into rows and totals, sorted by revenue", () => {
    const orgs = [
      { id: "o1", name: "Acme", slug: "acme", dataId: "o1", archived: false },
      { id: "o2", name: "Zed", slug: "zed", dataId: "o2", archived: false },
    ];
    const r = aggregateRollup(
      orgs,
      {
        revenue: [{ user_id: "o2", currency: "USD", revenue: "5000", n: "2" }],
        quotes: [{ user_id: "o1", n: 3, total: 120_000 }],
        bookings: [{ user_id: "o1", n: "4" }],
        tickets: [{ user_id: "o2", n: 1 }],
        ai: [{ user_id: "o1", cost: "250000", n: "7" }],
      },
      { from: "a", to: "b" }
    );
    expect(r.rows.map((x) => x.org.name)).toEqual(["Zed", "Acme"]);
    expect(r.rows[1]).toMatchObject({ open_quotes: 3, open_quotes_minor: 120_000, bookings: 4, ai_cost_micros: 250_000, ai_calls: 7, revenue_minor: 0 });
    expect(r.totals).toMatchObject({ clients: 2, revenue_minor: 5000, paid_invoices: 2, open_quotes: 3, bookings: 4, open_tickets: 1, ai_cost_micros: 250_000 });
    expect(r.totals.currencies).toEqual(["USD"]);
  });
});
