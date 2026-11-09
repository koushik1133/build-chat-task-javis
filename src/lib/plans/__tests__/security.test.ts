import { describe, expect, it, vi } from "vitest";
import { simulatedPaymentsAllowed } from "@/lib/payments";

vi.mock("@/lib/dsql", () => ({ query: vi.fn(), queryOne: vi.fn(), withRetry: (f: () => unknown) => f() }));
vi.mock("@/lib/events/bus", () => ({ emitEvent: vi.fn() }));
vi.mock("@/lib/credits/ledger", () => ({ postLedger: vi.fn() }));

import { invoiceMatchesPeriod } from "@/lib/plans/webhook";

describe("simulatedPaymentsAllowed", () => {
  it("is open outside production", () => {
    expect(simulatedPaymentsAllowed({ NODE_ENV: "development" })).toBe(true);
    expect(simulatedPaymentsAllowed({ NODE_ENV: "test" })).toBe(true);
  });
  it("is closed in production unless explicitly opted in", () => {
    expect(simulatedPaymentsAllowed({ NODE_ENV: "production" })).toBe(false);
    expect(simulatedPaymentsAllowed({ NODE_ENV: "production", PAYMENTS_ALLOW_SIMULATED: "false" })).toBe(false);
    expect(simulatedPaymentsAllowed({ NODE_ENV: "production", PAYMENTS_ALLOW_SIMULATED: "true" })).toBe(true);
  });
});

describe("invoiceMatchesPeriod (stale proration invoices)", () => {
  const end = "2026-12-01T00:00:00.000Z";
  it("accepts the same period on an active subscription", () => {
    expect(invoiceMatchesPeriod({ period_end: end }, { status: "active", current_period_end: end })).toBe(true);
  });
  it("rejects a period that has rolled over", () => {
    expect(invoiceMatchesPeriod({ period_end: end }, { status: "active", current_period_end: "2027-01-01T00:00:00.000Z" })).toBe(false);
  });
  it("rejects non-paid subscriptions and missing dates", () => {
    expect(invoiceMatchesPeriod({ period_end: end }, { status: "cancelled", current_period_end: end })).toBe(false);
    expect(invoiceMatchesPeriod({ period_end: end }, { status: "trialing", current_period_end: end })).toBe(false);
    expect(invoiceMatchesPeriod({ period_end: null }, { status: "active", current_period_end: end })).toBe(false);
  });
});
