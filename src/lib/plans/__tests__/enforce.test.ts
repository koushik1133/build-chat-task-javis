import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  checkLimit: vi.fn(),
  getEntitlements: vi.fn(),
}));

vi.mock("../entitlements", async () => {
  const actual = await vi.importActual<typeof import("../entitlements")>("../entitlements");
  return { ...actual, checkLimit: mocks.checkLimit, getEntitlements: mocks.getEntitlements };
});

import { PlanLimitError, assertFeature, assertWithinLimit } from "../enforce";
import { planGate, planLimitResponse } from "../http";

describe("enforcement", () => {
  const original = process.env.PLANS_ENFORCED;
  beforeEach(() => {
    mocks.checkLimit.mockReset();
    mocks.getEntitlements.mockReset();
  });
  afterEach(() => {
    if (original === undefined) delete process.env.PLANS_ENFORCED;
    else process.env.PLANS_ENFORCED = original;
  });

  it("is a no-op when PLANS_ENFORCED is not true", async () => {
    delete process.env.PLANS_ENFORCED;
    await expect(assertWithinLimit({ dataId: "o" }, "seats")).resolves.toBeUndefined();
    await expect(assertFeature({ dataId: "o" }, "sso_scim")).resolves.toBeUndefined();
    expect(mocks.checkLimit).not.toHaveBeenCalled();
    expect(await planGate({ dataId: "o" }, { metric: "contacts" })).toBeNull();
  });

  it("throws PlanLimitError over the limit when enforced and maps to 402", async () => {
    process.env.PLANS_ENFORCED = "true";
    mocks.checkLimit.mockResolvedValue({ allowed: false, used: 5, limit: 5, upgradeTo: "growth", over: true, enforced: true, metric: "seats" });
    await expect(assertWithinLimit({ dataId: "o" }, "seats")).rejects.toBeInstanceOf(PlanLimitError);
    const res = await planGate({ dataId: "o" }, { metric: "seats" });
    expect(res?.status).toBe(402);
    expect(await res?.json()).toMatchObject({ error: "plan_limit", metric: "seats", limit: 5, used: 5, upgrade_to: "growth", upgrade_url: "/settings/plan?upgrade=growth" });
  });

  it("allows within the limit and gates features by plan", async () => {
    process.env.PLANS_ENFORCED = "true";
    mocks.checkLimit.mockResolvedValue({ allowed: true, used: 1, limit: 5, upgradeTo: null, over: false, enforced: true, metric: "seats" });
    await expect(assertWithinLimit({ dataId: "o" }, "seats")).resolves.toBeUndefined();
    mocks.getEntitlements.mockResolvedValue({ plan: "free", features: { sso_scim: false } });
    const res = await planGate({ dataId: "o" }, { feature: "sso_scim" });
    expect(res?.status).toBe(402);
    expect(await res?.json()).toMatchObject({ error: "plan_limit", metric: "sso_scim", kind: "feature", upgrade_to: "scale" });
  });

  it("fails open when the lookup itself errors", async () => {
    process.env.PLANS_ENFORCED = "true";
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.checkLimit.mockRejectedValue(new Error("db down"));
    await expect(assertWithinLimit({ dataId: "o" }, "seats")).resolves.toBeUndefined();
  });

  it("planLimitResponse ignores other errors", () => {
    expect(planLimitResponse(new Error("x"))).toBeNull();
  });
});
