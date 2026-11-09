import { describe, expect, it } from "vitest";
import {
  checkStacking, csatStats, discountLines, evaluateVoucher, expirablePoints, isDetractor, isSelfReferral, isWellFormedGiftCode, maxRedeemablePoints,
  normalizeGiftCode, npsStats, pointsForAmount, referralGuard, safeReviewUrl, tierFor, DEFAULT_PROGRAM, DEFAULT_REFERRAL_POLICY, type VoucherLike,
} from "../pure";
import { computeTotals } from "@/lib/money/items";

const v = (o: Partial<VoucherLike> = {}): VoucherLike => ({ id: "v1", code_upper: "X", kind: "percent", value: 1000, currency: null, min_subtotal_minor: 0, max_uses: null, per_contact_limit: null, used_count: 0, starts_at: null, ends_at: null, applies_to: "all", applies_config: null, stackable: false, active: true, ...o });
const ctx = (o = {}) => ({ now: new Date("2026-06-01T00:00:00Z"), currency: "USD", subtotalMinor: 10000, items: [{ product_id: "p1", kind: "product", line_minor: 10000 }], contactUses: 0, ...o });

describe("survey maths", () => {
  it("computes NPS and CSAT", () => {
    expect(npsStats([10, 9, 8, 6, 0]).nps).toBe(0);
    expect(npsStats([10, 10, 9, 3])).toMatchObject({ promoters: 3, detractors: 1, nps: 50 });
    expect(npsStats([]).nps).toBeNull();
    expect(csatStats([5, 4, 3, 1])).toMatchObject({ csat: 50, average: 3.25 });
  });
  it("detractor thresholds", () => {
    expect(isDetractor("nps", 6)).toBe(true);
    expect(isDetractor("nps", 7)).toBe(false);
    expect(isDetractor("csat", 2)).toBe(true);
    expect(isDetractor("csat", 3)).toBe(false);
  });
  it("only https review links", () => {
    expect(safeReviewUrl("https://g.page/r/x")).toBeTruthy();
    expect(safeReviewUrl("http://g.page/r/x")).toBeNull();
    expect(safeReviewUrl("javascript:alert(1)")).toBeNull();
  });
});

describe("voucher rules matrix", () => {
  it("percent, fixed, caps", () => {
    expect(evaluateVoucher(v(), ctx())).toMatchObject({ ok: true, discountMinor: 1000 });
    expect(evaluateVoucher(v({ kind: "fixed", value: 99999, currency: "USD" }), ctx())).toMatchObject({ ok: true, discountMinor: 10000 });
  });
  it("rejections", () => {
    expect(evaluateVoucher(v({ active: false }), ctx())).toMatchObject({ ok: false, reason: "inactive" });
    expect(evaluateVoucher(v({ starts_at: "2026-07-01T00:00:00Z" }), ctx())).toMatchObject({ reason: "not_started" });
    expect(evaluateVoucher(v({ ends_at: "2026-05-01T00:00:00Z" }), ctx())).toMatchObject({ reason: "expired" });
    expect(evaluateVoucher(v({ max_uses: 2, used_count: 2 }), ctx())).toMatchObject({ reason: "exhausted" });
    expect(evaluateVoucher(v({ per_contact_limit: 1 }), ctx({ contactUses: 1 }))).toMatchObject({ reason: "contact_limit" });
    expect(evaluateVoucher(v({ min_subtotal_minor: 20000 }), ctx())).toMatchObject({ reason: "min_subtotal" });
    expect(evaluateVoucher(v({ kind: "fixed", value: 100, currency: "EUR" }), ctx())).toMatchObject({ reason: "currency" });
    expect(evaluateVoucher(v({ applies_to: "products", applies_config: { product_ids: ["zz"] } }), ctx())).toMatchObject({ reason: "not_applicable" });
  });
  it("product scoping and free shipping", () => {
    expect(evaluateVoucher(v({ applies_to: "products", applies_config: { product_ids: ["p1"] } }), ctx())).toMatchObject({ ok: true, discountMinor: 1000 });
    expect(evaluateVoucher(v({ kind: "free_shipping" }), ctx())).toMatchObject({ ok: true, freeShipping: true });
  });
  it("stacking", () => {
    expect(checkStacking([{ id: "a", stackable: true }, { id: "b", stackable: true }]).ok).toBe(true);
    expect(checkStacking([{ id: "a", stackable: true }, { id: "b", stackable: false }])).toEqual({ ok: false, offending: "b" });
  });
});

describe("discount lines are applied before tax", () => {
  it("reduces tax proportionally across rate groups", () => {
    const goods = [
      { description: "A", qty: 1, unit_minor: 6000, tax_rate_bp: 2000 },
      { description: "B", qty: 1, unit_minor: 4000, tax_rate_bp: 0 },
    ];
    const lines = discountLines(goods, 1000, "Discount (X)");
    expect(lines.reduce((s, l) => s + l.unit_minor, 0)).toBe(-1000);
    const t = computeTotals([...goods, ...lines]);
    expect(t.subtotal_minor).toBe(9000);
    expect(t.tax_minor).toBe(1080); // 20% of (6000-600)
  });
  it("never exceeds the goods subtotal", () => {
    const lines = discountLines([{ description: "A", qty: 1, unit_minor: 500, tax_rate_bp: 0 }], 9999, "d");
    expect(lines[0].unit_minor).toBe(-500);
  });
});

describe("loyalty maths", () => {
  const p = { ...DEFAULT_PROGRAM, enabled: true, tiers: [{ name: "Silver", min_points: 100, multiplier: 1.5 }, { name: "Gold", min_points: 500, multiplier: 2 }] };
  it("earns with multipliers and picks tiers at thresholds", () => {
    expect(pointsForAmount(p, 10050)).toBe(100);
    expect(pointsForAmount(p, 10000, 2)).toBe(200);
    expect(tierFor(p.tiers, 99)).toBeNull();
    expect(tierFor(p.tiers, 100)?.name).toBe("Silver");
    expect(tierFor(p.tiers, 500)?.name).toBe("Gold");
  });
  it("redeem cap and minimum", () => {
    expect(maxRedeemablePoints(p, 50, 10000)).toBe(0);
    expect(maxRedeemablePoints(p, 10000, 10000)).toBe(5000);
    expect(maxRedeemablePoints(p, 300, 10000)).toBe(300);
  });
  it("expiry spends oldest first", () => {
    const cutoff = new Date("2026-01-01");
    const e = [
      { kind: "earn" as const, points: 100, created_at: "2025-06-01" },
      { kind: "earn" as const, points: 50, created_at: "2026-03-01" },
      { kind: "redeem" as const, points: -30, created_at: "2026-04-01" },
    ];
    expect(expirablePoints(e, cutoff, 120)).toBe(70);
  });
});

describe("gift codes and referrals", () => {
  it("normalises and validates codes", () => {
    expect(normalizeGiftCode("abcd-2345 efgh-6789")).toBe("ABCD2345EFGH6789");
    expect(isWellFormedGiftCode("ABCD-2345-EFGH-6789")).toBe(true);
    expect(isWellFormedGiftCode("short")).toBe(false);
    expect(isWellFormedGiftCode("ABCD-2345-EFGH-0189")).toBe(false);
  });
  it("blocks self referral", () => {
    expect(isSelfReferral({ id: "a", email: "j.doe+x@gmail.com" }, { id: "b", email: "jdoe@gmail.com" })).toBe(true);
    expect(isSelfReferral({ id: "a", phone: "+1 555 010 9999" }, { id: "b", phone: "15550109999" })).toBe(true);
    expect(isSelfReferral({ id: "a", email: "a@x.com" }, { id: "b", email: "b@x.com" })).toBe(false);
  });
  it("guard order", () => {
    const base = { self: false, refereeAlreadyRewarded: false, rewardedThisMonth: 0, amountMinor: 100, policy: DEFAULT_REFERRAL_POLICY };
    expect(referralGuard(base)).toBeNull();
    expect(referralGuard({ ...base, self: true })).toBe("self_referral");
    expect(referralGuard({ ...base, refereeAlreadyRewarded: true })).toBe("already_rewarded");
    expect(referralGuard({ ...base, rewardedThisMonth: 20 })).toBe("monthly_cap");
    expect(referralGuard({ ...base, amountMinor: 0 })).toBe("below_minimum");
  });
});
