import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/dsql", () => ({ query: vi.fn(), queryOne: vi.fn(), withRetry: (fn: () => unknown) => fn() }));

import { aggregateJobCosting, jobKey, UNASSIGNED_KEY, type CostRow } from "@/lib/finance/job-costing";
import { timeValueMinor, minutesBetween } from "@/lib/finance/time";
import { expenseLineItem, timeLineItem } from "@/lib/finance/billables";
import { lineTotals } from "@/lib/money/items";

const USD = "USD";

describe("aggregateJobCosting", () => {
  it("returns zeroed totals for no rows", () => {
    const r = aggregateJobCosting([]);
    expect(r.jobs).toEqual([]);
    expect(r.totals).toEqual({
      revenue_minor: 0, expense_minor: 0, time_minor: 0, stock_minor: 0, cost_minor: 0, margin_minor: 0, margin_pct: null, currencies: [],
    });
  });

  it("sums revenue and each cost kind per job and computes margin", () => {
    const rows: CostRow[] = [
      { job_kind: "invoice", job_id: "I1", kind: "revenue", amount_minor: 100_000, currency: USD },
      { job_kind: "invoice", job_id: "I1", kind: "expense", amount_minor: 20_000, currency: USD },
      { job_kind: "invoice", job_id: "I1", kind: "expense", amount_minor: 5_000, currency: USD },
      { job_kind: "invoice", job_id: "I1", kind: "time", amount_minor: 30_000, currency: USD },
      { job_kind: "invoice", job_id: "I1", kind: "stock", amount_minor: 10_000, currency: USD },
    ];
    const r = aggregateJobCosting(rows, { labels: new Map([["invoice:I1", "INV-000001"]]) });
    expect(r.jobs).toHaveLength(1);
    const j = r.jobs[0];
    expect(j.label).toBe("INV-000001");
    expect(j.revenue_minor).toBe(100_000);
    expect(j.expense_minor).toBe(25_000);
    expect(j.time_minor).toBe(30_000);
    expect(j.stock_minor).toBe(10_000);
    expect(j.cost_minor).toBe(65_000);
    expect(j.margin_minor).toBe(35_000);
    expect(j.margin_pct).toBe(35);
    expect(r.totals.margin_pct).toBe(35);
    expect(r.totals.currencies).toEqual([USD]);
  });

  it("folds aliased jobs (quote → invoice) into one job", () => {
    const rows: CostRow[] = [
      { job_kind: "invoice", job_id: "I1", kind: "revenue", amount_minor: 50_000, currency: USD },
      { job_kind: "quote", job_id: "Q1", kind: "expense", amount_minor: 10_000, currency: USD },
    ];
    const r = aggregateJobCosting(rows, { aliases: new Map([["quote:Q1", "invoice:I1"]]) });
    expect(r.jobs).toHaveLength(1);
    expect(r.jobs[0].key).toBe("invoice:I1");
    expect(r.jobs[0].cost_minor).toBe(10_000);
    expect(r.jobs[0].margin_minor).toBe(40_000);
  });

  it("does not loop on circular aliases", () => {
    const rows: CostRow[] = [{ job_kind: "a", job_id: "1", kind: "expense", amount_minor: 1, currency: USD }];
    const r = aggregateJobCosting(rows, { aliases: new Map([["a:1", "b:1"], ["b:1", "a:1"]]) });
    expect(r.jobs).toHaveLength(1);
  });

  it("puts costs without a ref into an Unassigned bucket sorted last", () => {
    const rows: CostRow[] = [
      { job_kind: "none", job_id: "", kind: "expense", amount_minor: 999_999, currency: USD },
      { job_kind: "invoice", job_id: "I1", kind: "revenue", amount_minor: 100, currency: USD },
    ];
    const r = aggregateJobCosting(rows);
    expect(r.jobs.map((j) => j.key)).toEqual(["invoice:I1", UNASSIGNED_KEY]);
    expect(r.jobs[1].label).toBe("Unassigned");
    expect(r.totals.cost_minor).toBe(999_999);
  });

  it("margin_pct is null without revenue and negative when costs exceed revenue", () => {
    const r = aggregateJobCosting([
      { job_kind: "invoice", job_id: "A", kind: "expense", amount_minor: 100, currency: USD },
      { job_kind: "invoice", job_id: "B", kind: "revenue", amount_minor: 100, currency: USD },
      { job_kind: "invoice", job_id: "B", kind: "time", amount_minor: 150, currency: USD },
    ]);
    const a = r.jobs.find((j) => j.job_id === "A")!;
    const b = r.jobs.find((j) => j.job_id === "B")!;
    expect(a.margin_pct).toBeNull();
    expect(b.margin_minor).toBe(-50);
    expect(b.margin_pct).toBe(-50);
  });

  it("reports mixed currencies", () => {
    const r = aggregateJobCosting([
      { job_kind: "invoice", job_id: "A", kind: "revenue", amount_minor: 100, currency: "USD" },
      { job_kind: "invoice", job_id: "B", kind: "revenue", amount_minor: 100, currency: "EUR" },
    ]);
    expect(r.totals.currencies).toEqual(["EUR", "USD"]);
  });

  it("jobKey falls back to the unassigned key", () => {
    expect(jobKey("invoice", "x")).toBe("invoice:x");
    expect(jobKey(null, "x")).toBe(UNASSIGNED_KEY);
    expect(jobKey("invoice", "")).toBe(UNASSIGNED_KEY);
  });
});

describe("time helpers", () => {
  it("values minutes at an hourly rate, rounded half-up", () => {
    expect(timeValueMinor(60, 10_000)).toBe(10_000);
    expect(timeValueMinor(90, 10_000)).toBe(15_000);
    expect(timeValueMinor(1, 10_000)).toBe(167); // 166.67 → 167
    expect(timeValueMinor(0, 10_000)).toBe(0);
    expect(timeValueMinor(null, 10_000)).toBe(0);
    expect(timeValueMinor(30, 0)).toBe(0);
  });
  it("minutesBetween rounds to whole minutes and never goes negative", () => {
    expect(minutesBetween("2026-01-01T10:00:00Z", "2026-01-01T11:30:00Z")).toBe(90);
    expect(minutesBetween("2026-01-01T10:00:00Z", "2026-01-01T10:00:10Z")).toBe(1);
    expect(minutesBetween("2026-01-01T11:00:00Z", "2026-01-01T10:00:00Z")).toBe(0);
  });
});

describe("billable line items", () => {
  it("bills an expense at cost including tax with no extra tax", () => {
    const li = expenseLineItem({
      id: "e1", category: "materials", vendor: "Depot", description: "Lumber", amount_minor: 10_000, currency: "USD", tax_minor: 800, total_minor: 10_800,
      spent_at: "2026-01-01T00:00:00Z", receipt_url: null, ref_kind: null, ref_id: null, billable: true, invoice_id: null, created_by: null, created_at: "",
    });
    expect(li).toEqual({ description: "Expense · Depot — Lumber", qty: 1, unit_minor: 10_800, tax_rate_bp: 0 });
  });
  it("bills time at its exact minute-based value (hours and rate in the description)", () => {
    const li = timeLineItem({
      id: "t1", member_id: null, ref_kind: null, ref_id: null, description: "Site visit", started_at: "2026-02-03T09:00:00Z", ended_at: "2026-02-03T10:30:00Z",
      minutes: 90, running: false, rate_minor: 12_000, currency: "USD", value_minor: 18_000, billable: true, invoice_id: null, created_at: "",
    });
    expect(li).toEqual({ description: "Time · Site visit (2026-02-03) · 1.5 h @ 12000 USD/h", qty: 1, unit_minor: 18_000, tax_rate_bp: 0 });
  });
  it("invoiced time reconciles with job-costing time cost for awkward durations", () => {
    // 50 min @ 100.00/h: 2-dp hours × rate would bill 8300; costing counts 8333.
    for (const [minutes, rate] of [[50, 10_000], [25, 10_000], [7, 12_345], [1, 99]] as const) {
      const value = timeValueMinor(minutes, rate);
      const li = timeLineItem({
        id: "t", member_id: null, ref_kind: null, ref_id: null, description: null, started_at: "2026-02-03T09:00:00Z", ended_at: null,
        minutes, running: false, rate_minor: rate, currency: "USD", value_minor: value, billable: true, invoice_id: null, created_at: "",
      });
      expect(lineTotals(li).total_minor).toBe(value);
    }
  });
});
