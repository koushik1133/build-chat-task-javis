import { describe, expect, it } from "vitest";
import { buildDemoPlan, DEMO_TAG, planCounts } from "../plan";

describe("demo plan", () => {
  it("matches the brief's counts for any industry", () => {
    for (const ind of ["startup", "healthcare", "agency", "field-service", "realestate", "whatever"]) {
      const c = planCounts(buildDemoPlan(ind));
      expect(c, ind).toMatchObject({ contacts: 12, quotes: 6, invoices: 2, bookings: 8, tickets: 5, tasks: 10, records: 6, products: 4, outbox: 1 });
      expect(c.expenses).toBeGreaterThan(0);
      expect(c.timeEntries).toBeGreaterThan(0);
    }
  });

  it("is deterministic and internally consistent", () => {
    const a = buildDemoPlan("agency");
    const b = buildDemoPlan("agency");
    expect(a).toEqual(b);
    const refs = new Set(a.contacts.map((c) => c.ref));
    for (const q of a.quotes) expect(refs.has(q.contactRef), q.ref).toBe(true);
    for (const bk of a.bookings) expect(refs.has(bk.contactRef), bk.ref).toBe(true);
    for (const t of a.tickets) expect(refs.has(t.contactRef), t.ref).toBe(true);
    expect(refs.has(a.outboxEmail.recipientRef)).toBe(true);
    expect(new Set(a.contacts.map((c) => c.email)).size).toBe(12);
  });

  it("covers the required quote statuses, SLA states and booking window", () => {
    const p = buildDemoPlan("healthcare");
    expect(new Set(p.quotes.map((q) => q.status))).toEqual(new Set(["draft", "sent", "viewed", "accepted", "declined"]));
    const accepted = p.quotes.filter((q) => q.status === "accepted");
    expect(accepted.some((q) => q.invoicePaid)).toBe(true);
    expect(accepted.some((q) => !q.invoicePaid && (q.invoiceDueInDays ?? 0) < 0)).toBe(true);
    expect(new Set(p.tickets.map((t) => t.sla))).toEqual(new Set(["fresh", "at_risk", "breached", "resolved", "pending"]));
    expect(p.bookings.every((b) => b.dayOffset >= -14 && b.dayOffset <= 14)).toBe(true);
    expect(p.bookings.filter((b) => b.dayOffset === 0).length).toBeGreaterThan(0);
    expect(p.contacts.some((c) => c.lastContactDaysAgo === null && c.lifecycle !== "customer")).toBe(true);
    expect(p.contacts.every((c) => c.notes.includes(DEMO_TAG))).toBe(true);
    expect(p.products.filter((x) => x.stock_on_hand <= x.reorder_point && x.kind === "product").length).toBeGreaterThan(0);
  });
});
