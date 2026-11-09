import { describe, expect, it } from "vitest";
import {
  GRACE_DAYS,
  addMonthsClamped,
  advancePeriod,
  evaluateLimit,
  monthStart,
  nextRenewalAction,
  parseOverride,
  prorateUpgrade,
  resolveEntitlements,
  usagePercent,
} from "../rules";
import { PLANS, annualSavingsPercent, periodAmountMinor, planPriceIn, suggestFeaturePlan, suggestUpgrade } from "../catalog";

const NOW = new Date("2026-03-10T12:00:00Z");
const day = (n: number) => new Date(NOW.getTime() + n * 86_400_000);

describe("entitlement resolution", () => {
  it("active trial uses the trialled plan and reports days left", () => {
    const e = resolveEntitlements({ plan_key: "growth", status: "trialing", trial_ends_at: day(5), seats_purchased: 1 }, null, NOW);
    expect(e.plan).toBe("growth");
    expect(e.trial).toMatchObject({ active: true, daysLeft: 5 });
    expect(e.limits.contacts).toBe(PLANS.growth.entitlements.limits.contacts);
    expect(e.features.automations_v2).toBe(true);
  });

  it("expired trial falls back to Free limits", () => {
    const e = resolveEntitlements({ plan_key: "growth", status: "trialing", trial_ends_at: day(-1), seats_purchased: 1 }, null, NOW);
    expect(e.plan).toBe("free");
    expect(e.trial.active).toBe(false);
    expect(e.features.automations_v2).toBe(false);
  });

  it("paid plans keep their plan while past_due; cancelled drops to Free", () => {
    expect(resolveEntitlements({ plan_key: "scale", status: "past_due", trial_ends_at: null, seats_purchased: 1 }, null, NOW).plan).toBe("scale");
    expect(resolveEntitlements({ plan_key: "scale", status: "cancelled", trial_ends_at: null, seats_purchased: 1 }, null, NOW).plan).toBe("free");
  });

  it("purchased seats raise the seat cap on paid plans only", () => {
    const paid = resolveEntitlements({ plan_key: "starter", status: "active", trial_ends_at: null, seats_purchased: 9 }, null, NOW);
    expect(paid.limits.seats).toBe(9);
    const trial = resolveEntitlements({ plan_key: "starter", status: "trialing", trial_ends_at: day(3), seats_purchased: 9 }, null, NOW);
    expect(trial.limits.seats).toBe(PLANS.starter.entitlements.limits.seats);
  });

  it("overrides win over the plan and can lift limits to unlimited", () => {
    const override = parseOverride(JSON.stringify({ limits: { contacts: null, seats: 100 }, features: { sso_scim: true, bogus: true } }));
    const e = resolveEntitlements({ plan_key: "starter", status: "active", trial_ends_at: null, seats_purchased: 1 }, override, NOW);
    expect(e.limits.contacts).toBeNull();
    expect(e.limits.seats).toBe(100);
    expect(e.features.sso_scim).toBe(true);
    expect(e.overridden).toBe(true);
  });

  it("plan_key override replaces the effective plan; junk JSON is ignored", () => {
    const e = resolveEntitlements({ plan_key: "free", status: "active", trial_ends_at: null, seats_purchased: 1 }, parseOverride('{"plan_key":"enterprise"}'), NOW);
    expect(e.plan).toBe("enterprise");
    expect(parseOverride("not json")).toBeNull();
    expect(parseOverride(null)).toBeNull();
  });

  it("no subscription row resolves to Free", () => {
    expect(resolveEntitlements(null, null, NOW).plan).toBe("free");
  });
});

describe("limits", () => {
  it("evaluates against the limit, null is unlimited", () => {
    expect(evaluateLimit(4, 5, 1)).toBe(true);
    expect(evaluateLimit(5, 5, 1)).toBe(false);
    expect(evaluateLimit(0, 5, 6)).toBe(false);
    expect(evaluateLimit(1e9, null, 1000)).toBe(true);
  });
  it("percent for meters", () => {
    expect(usagePercent(50, 200)).toBe(25);
    expect(usagePercent(500, 200)).toBe(100);
    expect(usagePercent(5, null)).toBe(0);
    expect(usagePercent(1, 0)).toBe(100);
  });
  it("suggests the cheapest plan that fits", () => {
    expect(suggestUpgrade("free", "contacts", 300)).toBe("starter");
    expect(suggestUpgrade("starter", "contacts", 3000)).toBe("growth");
    expect(suggestUpgrade("scale", "contacts", 10_000_000)).toBe("enterprise");
    expect(suggestFeaturePlan("free", "sso_scim")).toBe("scale");
  });
});

describe("pricing", () => {
  it("annual saves ~17% and has explicit currency prices", () => {
    expect(annualSavingsPercent(PLANS.growth)).toBe(17);
    expect(planPriceIn(PLANS.growth, "inr").currency).toBe("INR");
    expect(planPriceIn(PLANS.growth, "JPY").currency).toBe("USD");
  });
  it("charges extra seats beyond the included ones", () => {
    const base = periodAmountMinor(PLANS.starter, "month", "USD", 5).amountMinor;
    expect(base).toBe(PLANS.starter.price.month);
    expect(periodAmountMinor(PLANS.starter, "month", "USD", 8).amountMinor).toBe(base + 3 * PLANS.starter.price.seatMonth);
  });
});

describe("proration", () => {
  const start = new Date("2026-03-01T00:00:00Z");
  const end = new Date("2026-03-31T00:00:00Z");
  it("charges the difference for the unused part of the period", () => {
    const half = new Date("2026-03-16T00:00:00Z");
    expect(prorateUpgrade({ oldAmountMinor: 2900, newAmountMinor: 7900, periodStart: start, periodEnd: end, now: half })).toBe(2500);
  });
  it("full difference at the start, zero at the end, never negative", () => {
    expect(prorateUpgrade({ oldAmountMinor: 2900, newAmountMinor: 7900, periodStart: start, periodEnd: end, now: start })).toBe(5000);
    expect(prorateUpgrade({ oldAmountMinor: 2900, newAmountMinor: 7900, periodStart: start, periodEnd: end, now: end })).toBe(0);
    expect(prorateUpgrade({ oldAmountMinor: 7900, newAmountMinor: 2900, periodStart: start, periodEnd: end, now: start })).toBe(0);
  });
});

describe("period advancement", () => {
  it("clamps to month end", () => {
    expect(addMonthsClamped(new Date("2026-01-31T00:00:00Z"), 1).toISOString()).toBe("2026-02-28T00:00:00.000Z");
    expect(addMonthsClamped(new Date("2028-01-31T00:00:00Z"), 1).toISOString()).toBe("2028-02-29T00:00:00.000Z");
    expect(addMonthsClamped(new Date("2026-11-30T00:00:00Z"), 3).toISOString()).toBe("2027-02-28T00:00:00.000Z");
    expect(addMonthsClamped(new Date("2026-12-15T00:00:00Z"), 1).toISOString()).toBe("2027-01-15T00:00:00.000Z");
  });
  it("advances monthly and yearly from the previous end", () => {
    const end = new Date("2026-05-31T00:00:00Z");
    expect(advancePeriod(end, "month").end.toISOString()).toBe("2026-06-30T00:00:00.000Z");
    expect(advancePeriod(end, "year").end.toISOString()).toBe("2027-05-31T00:00:00.000Z");
    expect(monthStart(new Date("2026-07-19T10:00:00Z"))).toBe("2026-07-01");
  });
});

describe("renewal state machine", () => {
  const base = { status: "active", provider: "stripe", cancel_at_period_end: false, trial_ends_at: null };
  it("does nothing before the period ends", () => {
    expect(nextRenewalAction({ ...base, current_period_end: day(1) }, NOW)).toBe("none");
  });
  it("simulated provider auto-renews; cancel-at-period-end ends instead", () => {
    expect(nextRenewalAction({ ...base, provider: "simulated", current_period_end: day(-1) }, NOW)).toBe("renew");
    expect(nextRenewalAction({ ...base, provider: "simulated", cancel_at_period_end: true, current_period_end: day(-1) }, NOW)).toBe("cancel");
  });
  it("real providers: grace, then past_due, then downgrade after 7 more days", () => {
    expect(nextRenewalAction({ ...base, current_period_end: day(-(GRACE_DAYS - 1)) }, NOW)).toBe("none");
    expect(nextRenewalAction({ ...base, current_period_end: day(-(GRACE_DAYS + 1)) }, NOW)).toBe("past_due");
    expect(nextRenewalAction({ ...base, status: "past_due", current_period_end: day(-(GRACE_DAYS + 1)) }, NOW)).toBe("none");
    expect(nextRenewalAction({ ...base, status: "past_due", current_period_end: day(-(GRACE_DAYS + 7 + 1)) }, NOW)).toBe("downgrade");
  });
  it("trials expire on schedule; other states are untouched", () => {
    expect(nextRenewalAction({ ...base, status: "trialing", current_period_end: null, trial_ends_at: day(-1) }, NOW)).toBe("expire_trial");
    expect(nextRenewalAction({ ...base, status: "trialing", current_period_end: null, trial_ends_at: day(2) }, NOW)).toBe("none");
    expect(nextRenewalAction({ ...base, status: "cancelled", current_period_end: day(-30) }, NOW)).toBe("none");
  });
});
