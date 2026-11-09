/**
 * Phase 11 code-review regressions: concurrent close-short write-off happens once,
 * points expiry reaches accounts behind a block of non-expirable ones.
 */
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { cleanupDataIds, createTestOrg, describeDb, setScope, sql, sqlOne, type TestOrg } from "./setup";

vi.mock("@/lib/auth/scope", () => import("./setup").then((m) => m.scopeMockFactory()));
vi.mock("@/lib/supabase/server", () => import("./setup").then((m) => m.supabaseMockFactory()));

describeDb("review11 regressions", () => {
  let org: TestOrg;
  beforeAll(async () => {
    org = await createTestOrg("review11");
    setScope(org);
  });
  afterAll(async () => {
    await sql(`DELETE FROM engagement_cursors WHERE name = $1`, [`pexp:${org.dataId}`]).catch(() => undefined);
    await cleanupDataIds([org.dataId]);
  });

  it("concurrent close_short receives write the shortage off exactly once", async () => {
    const { createProduct } = await import("@/lib/inventory/products");
    const { createLocation } = await import("@/lib/inventory/locations");
    const { createTransfer, shipTransfer, receiveTransfer } = await import("@/lib/inventory/transfers");
    const { checkStockInvariant } = await import("@/lib/inventory/levels");
    const p = await createProduct(org.dataId, { name: "Bolt", sku: "BLT-1", kind: "product", unit: "each", unit_price_minor: 100, cost_minor: 10, currency: "USD", tax_rate_bp: 0, track_stock: true, stock_on_hand: 10, reorder_point: 0, active: true });
    const A = await createLocation(org.dataId, { name: "A", kind: "warehouse" });
    const B = await createLocation(org.dataId, { name: "B", kind: "store" });
    const t = await createTransfer(org.dataId, { from_location_id: A.id, to_location_id: B.id, lines: [{ product_id: p.id, qty: 6 }] });
    await shipTransfer(org.dataId, t.id);
    const results = await Promise.allSettled([
      receiveTransfer(org.dataId, t.id, { lines: [{ product_id: p.id, received_qty: 2 }], close_short: true }),
      receiveTransfer(org.dataId, t.id, { lines: [{ product_id: p.id, received_qty: 2 }], close_short: true }),
    ]);
    expect(results.some((r) => r.status === "fulfilled")).toBe(true);
    const row = await sqlOne<{ stock_on_hand: number }>(`SELECT stock_on_hand FROM products WHERE id = $1`, [p.id]);
    // 10 on hand, 6 moved, at most 4 received in total, shortage written off once.
    const on = Number(row?.stock_on_hand);
    expect(on).toBeGreaterThanOrEqual(6);
    expect(on).toBeLessThanOrEqual(10);
    expect(await checkStockInvariant(org.dataId)).toEqual([]);
  });

  it("expirePoints reaches accounts behind a block of accounts with nothing expirable", async () => {
    const { expirePoints } = await import("@/lib/engagement/loyalty");
    await sql(`INSERT INTO loyalty_programs (user_id, enabled, earn_points, per_minor, redeem_value_minor_per_point, tiers, expiry_months, min_redeem_points, max_redeem_pct_bp) VALUES ($1, TRUE, 1, 100, 1, '[]', 6, 0, 10000)`, [org.dataId]);
    const old = new Date(Date.now() - 400 * 86_400_000).toISOString();
    for (const [id, when] of [["pa1", new Date().toISOString()], ["pa2", new Date().toISOString()], ["pa3", old]] as const) {
      await sql(`INSERT INTO loyalty_accounts (id, user_id, contact_id, balance, lifetime_points) VALUES ($1,$2,$3,50,50)`, [id + org.dataId, org.dataId, "c" + id]);
      await sql(`INSERT INTO loyalty_ledger (id, user_id, account_id, kind, points, balance_after, ref_kind, ref_id, created_at) VALUES ($1,$2,$3,'earn',50,50,'seed',$4,$5)`, ["l" + id + org.dataId, org.dataId, id + org.dataId, id, when]);
    }
    let expired = 0;
    for (let i = 0; i < 3 && expired === 0; i++) expired += (await expirePoints(2)).expired;
    expect(expired).toBe(50);
    const a3 = await sqlOne<{ balance: number }>(`SELECT balance FROM loyalty_accounts WHERE id = $1`, ["pa3" + org.dataId]);
    expect(Number(a3?.balance)).toBe(0);
  });
});
