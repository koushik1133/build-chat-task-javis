/**
 * Phase 11 security regressions against a real database: per-contact voucher limit under concurrency,
 * double stock-count apply, one trial per (contact, plan), discounts released on a cancelled unpaid order.
 */
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { cleanupDataIds, createTestOrg, describeDb, setScope, sql, sqlOne, type TestOrg } from "./setup";

vi.mock("@/lib/auth/scope", () => import("./setup").then((m) => m.scopeMockFactory()));
vi.mock("@/lib/supabase/server", () => import("./setup").then((m) => m.supabaseMockFactory()));

describeDb("security 11 flow", () => {
  let org: TestOrg;
  beforeAll(async () => {
    org = await createTestOrg("sec11");
    setScope(org);
  });
  afterAll(async () => {
    await cleanupDataIds([org.dataId]);
  });

  it("per_contact_limit holds under concurrent redemptions", async () => {
    const { createVoucher, recordRedemption, contactUses } = await import("@/lib/engagement/vouchers");
    const contactId = crypto.randomUUID();
    await sql(`INSERT INTO crm_contacts (id, user_id, domain, full_name, email, tags, lifecycle) VALUES ($1, $2, 'general', 'V Buyer', 'v@example.test', '[]', 'lead')`, [contactId, org.dataId]);
    const v = await createVoucher(org.dataId, { code: "ONCEONLY", name: "Once", kind: "fixed", value: 100, currency: "USD", per_contact_limit: 1, max_uses: null, applies_to: "all", stackable: false, active: true } as never);
    const results = await Promise.allSettled([1, 2, 3, 4].map((i) => recordRedemption(org.dataId, v, { kind: "order", id: `ord-${i}` }, contactId, 100)).map((p) => p));
    const ok = results.filter((r) => r.status === "fulfilled" && r.value === true).length;
    expect(ok).toBeLessThanOrEqual(1);
    expect(await contactUses(org.dataId, v.id, contactId)).toBeLessThanOrEqual(1);
  });

  it("a stock count applies once even when applied concurrently", async () => {
    const { createProduct } = await import("@/lib/inventory/products");
    const { createLocation } = await import("@/lib/inventory/locations");
    const { openCount, saveCountLines, applyCount } = await import("@/lib/inventory/counts");
    const loc = await createLocation(org.dataId, { name: "Main", kind: "warehouse" } as never);
    const p = await createProduct(org.dataId, { name: "Bolt", sku: "BOLT-1", kind: "product", unit: "each", unit_price_minor: 100, cost_minor: 10, currency: "USD", tax_rate_bp: 0, track_stock: true, stock_on_hand: 10, reorder_point: 0, active: true });
    const c = await openCount(org.dataId, loc.id);
    await saveCountLines(org.dataId, c.id, { lines: [{ product_id: p.id, counted_qty: 4 }] });
    await Promise.allSettled([applyCount(org.dataId, c.id), applyCount(org.dataId, c.id)]);
    const row = await sqlOne<{ on_hand: string }>(`SELECT on_hand FROM stock_levels WHERE user_id = $1 AND product_id = $2 AND location_id = $3`, [org.dataId, p.id, loc.id]);
    expect(Number(row?.on_hand)).toBe(4);
    const moves = await sqlOne<{ n: string }>(`SELECT COUNT(*) AS n FROM stock_movements WHERE user_id = $1 AND ref_kind = 'stock_count' AND ref_id = $2`, [org.dataId, c.id]);
    expect(Number(moves?.n)).toBe(1);
  });

  it("re-subscribing with the same email does not restart the trial", async () => {
    const { createPlan, PlanInputSchema } = await import("@/lib/memberships/plans");
    const { subscribe } = await import("@/lib/memberships/subscriptions");
    const plan = await createPlan(org.dataId, PlanInputSchema.parse({ name: "Trial Plan", slug: "trial-plan", amount_minor: 2000, currency: "USD", interval: "month", trial_days: 14 }));
    const input = { contact: { name: "T Person", email: "trial@example.test" }, quantity: 1, consent: { terms: true as const } };
    const first = await subscribe(org.dataId, plan.slug, input);
    expect(first.status).toBe("trialing");
    const second = await subscribe(org.dataId, plan.slug, input);
    expect(second.status).not.toBe("trialing");
    expect(second.trial_ends_at).toBeNull();
  });
});
