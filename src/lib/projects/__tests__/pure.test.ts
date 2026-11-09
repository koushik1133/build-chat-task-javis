import { describe, expect, it } from "vitest";
import { addDays, buildTimeline, computeBudget, computeProgress, daysBetween, mapQuoteToProject, parseDependsOn, weekBuckets, ymd } from "../pure";

const NOW = new Date("2026-03-10T12:00:00Z");

describe("projects/pure: progress", () => {
  it("counts done/total, overdue, estimates and days remaining", () => {
    const tasks = [
      { done: true, due_at: "2026-03-01T00:00:00Z", estimate_minutes: 60 },
      { done: false, due_at: "2026-03-05T00:00:00Z", estimate_minutes: 120 }, // overdue
      { done: false, due_at: "2026-03-20T00:00:00Z", estimate_minutes: null },
      { done: false, due_at: null, estimate_minutes: 30 },
    ];
    const milestones = [
      { id: "m1", name: "Kickoff", due_on: "2026-03-02", status: "done" as const, sort: 0 },
      { id: "m2", name: "Build", due_on: "2026-03-30", status: "open" as const, sort: 1 },
      { id: "m3", name: "Undated", due_on: null, status: "open" as const, sort: 2 },
    ];
    const p = computeProgress(tasks, milestones, { due_on: "2026-03-20" }, NOW);
    expect(p.tasks_total).toBe(4);
    expect(p.tasks_done).toBe(1);
    expect(p.percent).toBe(25);
    expect(p.overdue_tasks).toBe(1);
    expect(p.milestones_done).toBe(1);
    expect(p.milestones_total).toBe(3);
    expect(p.next_milestone?.id).toBe("m2"); // dated open milestone wins over undated
    expect(p.days_remaining).toBe(10);
    expect(p.estimate_minutes_total).toBe(210);
    expect(p.estimate_minutes_remaining).toBe(150);
  });
  it("handles an empty project", () => {
    const p = computeProgress([], [], { due_on: null }, NOW);
    expect(p.percent).toBe(0);
    expect(p.days_remaining).toBeNull();
    expect(p.next_milestone).toBeNull();
  });
  it("reports negative days when late", () => {
    expect(computeProgress([], [], { due_on: "2026-03-01" }, NOW).days_remaining).toBe(-9);
  });
});

describe("projects/pure: budget", () => {
  it("sums actuals, computes burn and remaining", () => {
    const b = computeBudget({ budget_minor: 100_000, currency: "USD", time_minutes: 120, time_minor: 20_000, expense_minor: 15_000, stock_minor: 5_000, billed_minor: 50_000, paid_minor: 25_000 });
    expect(b.actual_minor).toBe(40_000);
    expect(b.remaining_minor).toBe(60_000);
    expect(b.burn_pct).toBe(40);
    expect(b.over_budget).toBe(false);
  });
  it("flags over budget and null burn without a budget", () => {
    expect(computeBudget({ budget_minor: 1000, currency: "USD", time_minutes: 0, time_minor: 900, expense_minor: 200, stock_minor: 0, billed_minor: 0, paid_minor: 0 }).over_budget).toBe(true);
    const nb = computeBudget({ budget_minor: 0, currency: "USD", time_minutes: 0, time_minor: 100, expense_minor: 0, stock_minor: 0, billed_minor: 0, paid_minor: 0 });
    expect(nb.burn_pct).toBeNull();
    expect(nb.over_budget).toBe(false);
  });
});

describe("projects/pure: timeline", () => {
  const project = { id: "p", name: "P", starts_on: "2026-03-02", due_on: "2026-03-27" };
  it("places milestones as single days, tasks as bars from start to due, and pads the range", () => {
    const t = buildTimeline(
      project,
      [{ id: "m1", name: "Design", due_on: "2026-03-13", status: "open", sort: 0 }],
      [
        { id: "t1", title: "Measure", done: false, due_at: "2026-03-06T17:00:00Z", created_at: "2026-02-20T00:00:00Z", estimate_minutes: null, assignee_id: null, milestone_id: null },
        { id: "t2", title: "Order", done: true, due_at: null, created_at: "2026-03-04T09:00:00Z", estimate_minutes: null, assignee_id: null, milestone_id: "m1" },
      ],
      NOW
    );
    expect(t.today).toBe("2026-03-10");
    expect(t.range.start).toBe("2026-03-01");
    expect(t.range.end).toBe("2026-03-28");
    expect(t.range.days).toBe(28);
    const m = t.items.find((i) => i.id === "m1")!;
    expect(m.kind).toBe("milestone");
    expect(m.start).toBe("2026-03-13");
    expect(m.end).toBe("2026-03-13");
    const t1 = t.items.find((i) => i.id === "t1")!;
    expect(t1.start).toBe("2026-03-02"); // clamped to project start, not created_at
    expect(t1.end).toBe("2026-03-06");
    expect(t1.overdue).toBe(true);
    const t2 = t.items.find((i) => i.id === "t2")!;
    expect(t2.start).toBe("2026-03-04");
    expect(t2.end).toBe("2026-03-04"); // undated → single day
    expect(t2.done).toBe(true);
  });
  it("extends the range to cover late items and today, with at least two weeks", () => {
    const t = buildTimeline({ id: "p", name: "P", starts_on: null, due_on: null }, [{ id: "m", name: "Late", due_on: "2026-04-20", status: "open", sort: 0 }], [], NOW);
    expect(t.range.start).toBe("2026-03-09");
    expect(t.range.end).toBe("2026-04-21");
    const short = buildTimeline({ id: "p", name: "P", starts_on: null, due_on: null }, [], [], NOW);
    expect(daysBetween(short.range.start, short.range.end)).toBeGreaterThanOrEqual(14);
  });
  it("buckets a range into Monday-start weeks", () => {
    const w = weekBuckets({ start: "2026-03-04", end: "2026-03-17" }); // Wed → Tue
    expect(w.length).toBe(3);
    expect(w[0]).toMatchObject({ start: "2026-03-04", end: "2026-03-08", days: 5 });
    expect(w[1]).toMatchObject({ start: "2026-03-09", end: "2026-03-15", days: 7 });
    expect(w[2]).toMatchObject({ start: "2026-03-16", end: "2026-03-17", days: 2 });
    expect(w.reduce((s, x) => s + x.days, 0)).toBe(14);
  });
  it("date helpers", () => {
    expect(ymd("2026-03-10T23:59:00Z")).toBe("2026-03-10");
    expect(addDays("2026-02-28", 2)).toBe("2026-03-02");
    expect(daysBetween("2026-03-01", "2026-02-27")).toBe(-2);
  });
});

describe("projects/pure: quote mapping", () => {
  const quote = { id: "q1", number: "Q-0007", contact_id: "c1", contact_name: "Smith & Co", currency: "GBP", total_minor: 250_000, items: [{ description: "Design", qty: 1 }, { description: "Build", qty: 1 }, { description: "design", qty: 2 }, { description: "  ", qty: 1 }] };
  it("maps budget, currency, contact, code and de-duplicated milestones", () => {
    const { project, milestones } = mapQuoteToProject(quote);
    expect(project.name).toBe("Smith & Co — Q-0007");
    expect(project.code).toBe("Q-0007");
    expect(project.budget_minor).toBe(250_000);
    expect(project.currency).toBe("GBP");
    expect(project.contact_id).toBe("c1");
    expect(project.quote_id).toBe("q1");
    expect(project.billing_mode).toBe("fixed");
    expect(milestones.map((m) => m.name)).toEqual(["Design", "Build"]);
    expect(milestones[1].sort).toBe(1);
  });
  it("honours overrides and can skip milestones", () => {
    const { project, milestones } = mapQuoteToProject(quote, { name: "Refit", milestonesFromItems: false, due_on: "2026-06-01" });
    expect(project.name).toBe("Refit");
    expect(project.due_on).toBe("2026-06-01");
    expect(milestones).toEqual([]);
  });
  it("parses depends_on defensively", () => {
    expect(parseDependsOn(null)).toEqual([]);
    expect(parseDependsOn("nope")).toEqual([]);
    expect(parseDependsOn('["a", 1, "b"]')).toEqual(["a", "b"]);
  });
});
