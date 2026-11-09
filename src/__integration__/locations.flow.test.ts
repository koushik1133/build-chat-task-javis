/**
 * Multi-location inventory end-to-end: backfill → second location → transfers
 * (ship / partial receive / short close / cancel) → storefront order reserves at
 * the fulfilment location → paid consumes there → PO received into a location →
 * stock count → invariant sum(levels) == product totals throughout → v1 +
 * 401/403 → plan limit with PLANS_ENFORCED.
 */
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { api, cleanupDataIds, createTestOrg, describeDb, setScope, sql, sqlOne, type TestOrg } from "./setup";

vi.mock("@/lib/auth/scope", () => import("./setup").then((m) => m.scopeMockFactory()));
vi.mock("@/lib/supabase/server", () => import("./setup").then((m) => m.supabaseMockFactory()));

interface Loc { id: string; name: string; is_default: boolean; active: boolean }
interface Level { product_id: string; location_id: string; on_hand: number; reserved: number; available: number }
interface Transfer { id: string; number: string; status: string; lines: Array<{ product_id: string; qty: number; received_qty: number; remaining: number }> }
interface Count { id: string; status: string; location_id: string; lines: Array<{ product_id: string; expected_qty: number; counted_qty: number | null; variance: number | null }> }

const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

describeDb("locations flow", () => {
  let org: TestOrg;
  let widget: { id: string };
  let gadget: { id: string };
  let A: Loc;
  let B: Loc;
  const prevEnforced = process.env.PLANS_ENFORCED;

  beforeAll(async () => {
    org = await createTestOrg("locations");
    setScope(org);
    delete process.env.PLANS_ENFORCED;
    const { createProduct } = await import("@/lib/inventory/products");
    widget = await createProduct(org.dataId, { name: "Widget", sku: "WID-1", kind: "product", unit: "each", unit_price_minor: 1000, cost_minor: 400, currency: "USD", tax_rate_bp: 0, track_stock: true, stock_on_hand: 10, reorder_point: 1, active: true });
    gadget = await createProduct(org.dataId, { name: "Gadget", sku: "GAD-1", kind: "product", unit: "each", unit_price_minor: 500, cost_minor: 100, currency: "USD", tax_rate_bp: 0, track_stock: true, stock_on_hand: 5, reorder_point: 0, active: true });
  });
  afterAll(async () => {
    if (prevEnforced === undefined) delete process.env.PLANS_ENFORCED;
    else process.env.PLANS_ENFORCED = prevEnforced;
    await cleanupDataIds([org.dataId]);
  });

  const levels = async (productId: string) => (await api<{ levels: Level[] }>((await import("@/app/api/stock/levels/route")).GET, "/api/stock/levels", { query: { product: productId }, expect: 200 })).body.levels;
  const at = (ls: Level[], loc: Loc) => ls.find((l) => l.location_id === loc.id);
  async function invariant() {
    const { checkStockInvariant } = await import("@/lib/inventory/levels");
    expect(await checkStockInvariant(org.dataId)).toEqual([]);
  }

  it("legacy mode: no locations means no levels and the old stock route still works", async () => {
    expect(await levels(widget.id)).toEqual([]);
    const stock = await import("@/app/api/products/[id]/stock/route");
    await api(stock.POST, `/api/products/${widget.id}/stock`, { json: { kind: "receive", qty: 0 }, params: { id: widget.id }, expect: 400 });
  });

  it("first location becomes the default and backfills levels from product totals (idempotent)", async () => {
    const route = await import("@/app/api/locations/route");
    await api(route.POST, "/api/locations", { json: { name: "x", bogus: 1 }, expect: 400 });
    A = (await api<{ location: Loc }>(route.POST, "/api/locations", { json: { name: "Warehouse", code: "WH", kind: "warehouse", address: { city: "Austin", country: "US" } }, expect: 201 })).body.location;
    expect(A.is_default).toBe(true);
    const lv = await levels(widget.id);
    expect(lv).toHaveLength(1);
    expect(at(lv, A)).toMatchObject({ on_hand: 10, reserved: 0 });
    const { ensureLevelsBackfilled } = await import("@/lib/inventory/locations");
    expect((await ensureLevelsBackfilled(org.dataId)).created).toBe(0);
    expect((await ensureLevelsBackfilled(org.dataId)).created).toBe(0);
    B = (await api<{ location: Loc }>(route.POST, "/api/locations", { json: { name: "Store", kind: "store" }, expect: 201 })).body.location;
    expect(B.is_default).toBe(false);
    await invariant();
  });

  it("adjust at a chosen location keeps totals in sync; negative stock is refused with 409", async () => {
    const adj = await import("@/app/api/stock/adjust/route");
    await api(adj.POST, "/api/stock/adjust", { json: { product_id: widget.id, location_id: B.id, kind: "receive", qty: 2 }, expect: 200 });
    expect(at(await levels(widget.id), B)).toMatchObject({ on_hand: 2 });
    const p = await sqlOne<{ stock_on_hand: number }>(`SELECT stock_on_hand FROM products WHERE id = $1`, [widget.id]);
    expect(Number(p?.stock_on_hand)).toBe(12);
    const over = await api<{ error: string }>(adj.POST, "/api/stock/adjust", { json: { product_id: widget.id, location_id: B.id, kind: "consume", qty: 50 }, expect: 409 });
    expect(over.body.error).toBe("insufficient_stock");
    await api(adj.POST, "/api/stock/adjust", { json: { product_id: widget.id, location_id: B.id, kind: "adjust", qty: -2 }, expect: 200 });
    await api(adj.POST, "/api/stock/adjust", { json: { product_id: widget.id, location_id: "nope", kind: "receive", qty: 1 }, expect: 404 });
    await invariant();
  });

  it("transfer: draft → ship → partial receive → receive; totals unchanged", async () => {
    const tr = await import("@/app/api/transfers/route");
    const ship = await import("@/app/api/transfers/[id]/ship/route");
    const recv = await import("@/app/api/transfers/[id]/receive/route");
    await api(tr.POST, "/api/transfers", { json: { from_location_id: A.id, to_location_id: A.id, lines: [{ product_id: widget.id, qty: 1 }] }, expect: 400 });
    const t = (await api<{ transfer: Transfer }>(tr.POST, "/api/transfers", { json: { from_location_id: A.id, to_location_id: B.id, lines: [{ product_id: widget.id, qty: 4 }] }, expect: 201 })).body.transfer;
    expect(t.number).toMatch(/^TRF-\d{6}$/);
    expect(t.status).toBe("draft");
    await api(recv.POST, `/api/transfers/${t.id}/receive`, { json: {}, params: { id: t.id }, expect: 409 });
    const shipped = (await api<{ transfer: Transfer }>(ship.POST, `/api/transfers/${t.id}/ship`, { json: {}, params: { id: t.id }, expect: 200 })).body.transfer;
    expect(shipped.status).toBe("in_transit");
    // Shipping again is a no-op, not a double decrement.
    await api(ship.POST, `/api/transfers/${t.id}/ship`, { json: {}, params: { id: t.id }, expect: 200 });
    expect(at(await levels(widget.id), A)?.on_hand).toBe(6);
    await invariant();

    await api(recv.POST, `/api/transfers/${t.id}/receive`, { json: { lines: [{ product_id: widget.id, received_qty: 9 }] }, params: { id: t.id }, expect: 400 });
    const partial = (await api<{ transfer: Transfer }>(recv.POST, `/api/transfers/${t.id}/receive`, { json: { lines: [{ product_id: widget.id, received_qty: 3 }] }, params: { id: t.id }, expect: 200 })).body.transfer;
    expect(partial.status).toBe("in_transit");
    expect(partial.lines[0]).toMatchObject({ received_qty: 3, remaining: 1 });
    expect(at(await levels(widget.id), B)?.on_hand).toBe(3);
    await invariant();
    const done = (await api<{ transfer: Transfer }>(recv.POST, `/api/transfers/${t.id}/receive`, { json: {}, params: { id: t.id }, expect: 200 })).body.transfer;
    expect(done.status).toBe("received");
    const ls = await levels(widget.id);
    expect([at(ls, A)?.on_hand, at(ls, B)?.on_hand]).toEqual([6, 4]);
    const p = await sqlOne<{ stock_on_hand: number }>(`SELECT stock_on_hand FROM products WHERE id = $1`, [widget.id]);
    expect(Number(p?.stock_on_hand)).toBe(10);
    const mv = await sql(`SELECT kind FROM stock_movements WHERE user_id = $1 AND transfer_id = $2`, [org.dataId, t.id]);
    expect(mv.length).toBe(3);
    await invariant();
  });

  it("transfer: shortage written off on close; cancel returns stock; insufficient stock leaves a draft", async () => {
    const tr = await import("@/app/api/transfers/route");
    const ship = await import("@/app/api/transfers/[id]/ship/route");
    const recv = await import("@/app/api/transfers/[id]/receive/route");
    const cancel = await import("@/app/api/transfers/[id]/cancel/route");
    const g = (await api<{ transfer: Transfer }>(tr.POST, "/api/transfers", { json: { from_location_id: A.id, to_location_id: B.id, lines: [{ product_id: gadget.id, qty: 5 }] }, expect: 201 })).body.transfer;
    await api(ship.POST, `/api/transfers/${g.id}/ship`, { json: {}, params: { id: g.id }, expect: 200 });
    await invariant();
    const closed = (await api<{ transfer: Transfer }>(recv.POST, `/api/transfers/${g.id}/receive`, { json: { lines: [{ product_id: gadget.id, received_qty: 2 }], close_short: true }, params: { id: g.id }, expect: 200 })).body.transfer;
    expect(closed.status).toBe("received");
    const p = await sqlOne<{ stock_on_hand: number }>(`SELECT stock_on_hand FROM products WHERE id = $1`, [gadget.id]);
    expect(Number(p?.stock_on_hand)).toBe(2);
    await invariant();

    const c = (await api<{ transfer: Transfer }>(tr.POST, "/api/transfers", { json: { from_location_id: A.id, to_location_id: B.id, lines: [{ product_id: widget.id, qty: 2 }] }, expect: 201 })).body.transfer;
    await api(ship.POST, `/api/transfers/${c.id}/ship`, { json: {}, params: { id: c.id }, expect: 200 });
    expect(at(await levels(widget.id), A)?.on_hand).toBe(4);
    const cancelled = (await api<{ transfer: Transfer }>(cancel.POST, `/api/transfers/${c.id}/cancel`, { json: {}, params: { id: c.id }, expect: 200 })).body.transfer;
    expect(cancelled.status).toBe("cancelled");
    expect(at(await levels(widget.id), A)?.on_hand).toBe(6);
    await api(ship.POST, `/api/transfers/${c.id}/ship`, { json: {}, params: { id: c.id }, expect: 409 });
    await invariant();

    const big = (await api<{ transfer: Transfer }>(tr.POST, "/api/transfers", { json: { from_location_id: A.id, to_location_id: B.id, lines: [{ product_id: widget.id, qty: 100 }] }, expect: 201 })).body.transfer;
    await api(ship.POST, `/api/transfers/${big.id}/ship`, { json: {}, params: { id: big.id }, expect: 409 });
    const row = await sqlOne<{ status: string }>(`SELECT status FROM stock_transfers WHERE id = $1`, [big.id]);
    expect(row?.status).toBe("draft");
    await invariant();
  });

  it("storefront order reserves at the fulfilment location and paid consumes there", async () => {
    const sf = await import("@/app/api/storefront/route");
    await api(sf.PATCH, "/api/storefront", { method: "PATCH", json: { fulfil_location_id: "nope" }, expect: 404 });
    const on = await api<{ storefront: { slug: string; fulfil_location_id: string | null } }>(sf.PATCH, "/api/storefront", {
      method: "PATCH", json: { enabled: true, title: "Shop", collect_shipping: false, pickup_enabled: true, fulfil_location_id: B.id }, expect: 200,
    });
    expect(on.body.storefront.fulfil_location_id).toBe(B.id);
    const slug = on.body.storefront.slug;
    const sp = await import("@/app/api/storefront/products/route");
    await api(sp.PUT, "/api/storefront/products", { method: "PUT", json: { product_id: widget.id, visible: true, sort: 1 }, expect: 200 });
    const cart = await import("@/app/api/shop/[org]/cart/route");
    const first = await api<{ cart: unknown }>(cart.GET, `/api/shop/${slug}/cart`, { params: { org: slug }, expect: 200 });
    const cookie = (first.res.headers.get("set-cookie") ?? "").match(/(kh_cart_[^=]+=[^;]+)/)?.[1] ?? "";
    expect(cookie).not.toBe("");
    await api(cart.POST, `/api/shop/${slug}/cart`, { json: { product_id: widget.id, qty: 2 }, headers: { cookie }, params: { org: slug }, expect: 200 });
    const checkout = await import("@/app/api/shop/[org]/checkout/route");
    const r = await api<{ pay_url: string }>(checkout.POST, `/api/shop/${slug}/checkout`, { json: { name: "Sam Shopper", email: "sam@example.test" }, headers: { cookie }, params: { org: slug }, expect: 201 });
    const order = await sqlOne<{ id: string; invoice_id: string }>(`SELECT id, invoice_id FROM orders WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`, [org.dataId]);
    const reserve = await sql<{ location_id: string | null; qty: number }>(`SELECT location_id, qty FROM stock_movements WHERE user_id = $1 AND ref_kind = 'order' AND ref_id = $2 AND kind = 'reserve'`, [org.dataId, order!.id]);
    expect(reserve).toEqual([{ location_id: B.id, qty: 2 }]);
    expect(at(await levels(widget.id), B)).toMatchObject({ on_hand: 4, reserved: 2 });
    await invariant();

    const payToken = r.body.pay_url.split("/p/pay/")[1].split("?")[0];
    const pay = await import("@/app/api/p/pay/[token]/route");
    await api(pay.POST, `/api/p/pay/${payToken}`, { json: { outcome: "success" }, params: { token: payToken }, expect: 200 });
    const after = await levels(widget.id);
    expect(at(after, B)).toMatchObject({ on_hand: 2, reserved: 0 });
    expect(at(after, A)).toMatchObject({ on_hand: 6, reserved: 0 });
    const consume = await sql<{ location_id: string | null }>(`SELECT location_id FROM stock_movements WHERE user_id = $1 AND ref_kind = 'invoice' AND ref_id = $2 AND kind = 'consume'`, [org.dataId, order!.invoice_id]);
    expect(consume).toEqual([{ location_id: B.id }]);
    await invariant();
  });

  it("an order larger than the preferred location splits across locations; release restores both", async () => {
    const { reserveForOrder, releaseForOrder } = await import("@/lib/inventory/stock");
    const item = { description: "Widget", qty: 7, unit_minor: 1000, tax_rate_bp: 0, product_id: widget.id };
    const r = await reserveForOrder(org.dataId, "split-order-1", [item], { preferLocationId: B.id });
    expect(r.reserved).toEqual([{ product_id: widget.id, qty: 7 }]);
    const ls = await levels(widget.id);
    expect([at(ls, B)?.reserved, at(ls, A)?.reserved]).toEqual([2, 5]);
    await invariant();
    await expect(reserveForOrder(org.dataId, "split-order-2", [{ ...item, qty: 5 }], { preferLocationId: B.id })).rejects.toMatchObject({ name: "InsufficientStockError" });
    await invariant();
    await releaseForOrder(org.dataId, "split-order-1");
    const back = await levels(widget.id);
    expect([at(back, B)?.reserved, at(back, A)?.reserved]).toEqual([0, 0]);
    await invariant();
  });

  it("PO receives into a chosen location", async () => {
    const suppliers = await import("@/app/api/suppliers/route");
    const sup = (await api<{ supplier: { id: string } }>(suppliers.POST, "/api/suppliers", { json: { name: "Acme", email: "orders@acme.test", currency: "USD" }, expect: 201 })).body.supplier;
    const pos = await import("@/app/api/purchase-orders/route");
    const po = (await api<{ purchase_order: { id: string } }>(pos.POST, "/api/purchase-orders", { json: { supplier_id: sup.id, items: [{ description: "Gadget", qty: 6, unit_minor: 100, tax_rate_bp: 0, product_id: gadget.id }] }, expect: 201 })).body.purchase_order;
    const send = await import("@/app/api/purchase-orders/[id]/send/route");
    await api(send.POST, `/api/purchase-orders/${po.id}/send`, { json: {}, params: { id: po.id }, expect: 200 });
    const receive = await import("@/app/api/purchase-orders/[id]/receive/route");
    await api(receive.POST, `/api/purchase-orders/${po.id}/receive`, { json: { lines: [{ product_id: gadget.id, qty: 4 }], location_id: B.id }, params: { id: po.id }, expect: 200 });
    expect(at(await levels(gadget.id), B)?.on_hand).toBe(6);
    await api(receive.POST, `/api/purchase-orders/${po.id}/receive`, { json: { lines: [{ product_id: gadget.id, qty: 2 }] }, params: { id: po.id }, expect: 200 });
    expect(at(await levels(gadget.id), A)?.on_hand).toBe(2);
    await invariant();
  });

  it("per-location reorder point feeds reorder suggestions", async () => {
    await sql(`UPDATE stock_levels SET reorder_point = 20 WHERE user_id = $1 AND product_id = $2 AND location_id = $3`, [org.dataId, gadget.id, B.id]);
    const { reorderSuggestions } = await import("@/lib/procurement/reorder");
    const r = await reorderSuggestions(org.dataId);
    expect(r.suggestions.map((s) => s.product_id)).toContain(gadget.id);
  });

  it("stock count: variance applies once as adjust movements", async () => {
    const counts = await import("@/app/api/stock-counts/route");
    const lines = await import("@/app/api/stock-counts/[id]/lines/route");
    const apply = await import("@/app/api/stock-counts/[id]/apply/route");
    const c = (await api<{ count: Count }>(counts.POST, "/api/stock-counts", { json: { location_id: B.id }, expect: 201 })).body.count;
    expect(c.status).toBe("open");
    const w = c.lines.find((l) => l.product_id === widget.id)!;
    expect(w.expected_qty).toBe(2);
    await api(apply.POST, `/api/stock-counts/${c.id}/apply`, { json: {}, params: { id: c.id }, expect: 409 });
    await api(lines.POST, `/api/stock-counts/${c.id}/lines`, { json: { lines: [{ product_id: "nope", counted_qty: 1 }] }, params: { id: c.id }, expect: 400 });
    const saved = (await api<{ count: Count }>(lines.POST, `/api/stock-counts/${c.id}/lines`, { json: { lines: [{ product_id: widget.id, counted_qty: 1 }] }, params: { id: c.id }, expect: 200 })).body.count;
    expect(saved.status).toBe("counted");
    expect(saved.lines.find((l) => l.product_id === widget.id)?.variance).toBe(-1);
    const done = (await api<{ count: Count }>(apply.POST, `/api/stock-counts/${c.id}/apply`, { json: {}, params: { id: c.id }, expect: 200 })).body.count;
    expect(done.status).toBe("applied");
    await api(apply.POST, `/api/stock-counts/${c.id}/apply`, { json: {}, params: { id: c.id }, expect: 200 });
    const mv = await sql(`SELECT qty FROM stock_movements WHERE user_id = $1 AND ref_kind = 'stock_count' AND ref_id = $2`, [org.dataId, c.id]);
    expect(mv).toEqual([{ qty: -1 }]);
    expect(at(await levels(widget.id), B)?.on_hand).toBe(1);
    await invariant();
  });

  it("archive is refused while stock remains and works once empty", async () => {
    const route = await import("@/app/api/locations/route");
    const byId = await import("@/app/api/locations/[id]/route");
    await api(byId.PATCH, `/api/locations/${B.id}`, { method: "PATCH", json: { active: false }, params: { id: B.id }, expect: 409 });
    await api(byId.PATCH, `/api/locations/${A.id}`, { method: "PATCH", json: { active: false }, params: { id: A.id }, expect: 409 });
    const C = (await api<{ location: Loc }>(route.POST, "/api/locations", { json: { name: "Van 1", kind: "van" }, expect: 201 })).body.location;
    const archived = await api<{ location: Loc }>(byId.PATCH, `/api/locations/${C.id}`, { method: "PATCH", json: { active: false }, params: { id: C.id }, expect: 200 });
    expect(archived.body.location.active).toBe(false);
    const list = await api<{ locations: Loc[] }>(route.GET, "/api/locations", { expect: 200 });
    expect(list.body.locations.map((l) => l.id)).not.toContain(C.id);
  });

  it("auth: viewer cannot write, anonymous gets 401", async () => {
    const route = await import("@/app/api/locations/route");
    const tr = await import("@/app/api/transfers/route");
    setScope(org, { role: "viewer", userId: "itest-viewer" });
    await api(route.POST, "/api/locations", { json: { name: "Nope" }, expect: 403 });
    await api(tr.GET, "/api/transfers", { expect: 200 });
    setScope(null);
    await api(tr.GET, "/api/transfers", { expect: 401 });
    setScope(org);
  });

  it("v1: 401 without a key, 403 with the wrong scope, reads + create transfer with billing scopes", async () => {
    const v1 = await import("@/app/api/v1/locations/route");
    await api(v1.GET, "/api/v1/locations", { expect: 401 });
    const keys = await import("@/app/api/api-keys/route");
    const wrong = await api<{ key: string }>(keys.POST, "/api/api-keys", { json: { name: "wrong", scopes: ["read:crm"] }, expect: 201 });
    await api(v1.GET, "/api/v1/locations", { headers: bearer(wrong.body.key), expect: 403 });
    const right = await api<{ key: string }>(keys.POST, "/api/api-keys", { json: { name: "billing", scopes: ["write:billing"] }, expect: 201 });
    const h = bearer(right.body.key);
    const l = await api<{ data: Loc[] }>(v1.GET, "/api/v1/locations", { headers: h, expect: 200 });
    expect(l.body.data.map((x) => x.id)).toEqual(expect.arrayContaining([A.id, B.id]));
    const one = await import("@/app/api/v1/locations/[id]/route");
    await api(one.GET, `/api/v1/locations/${A.id}`, { headers: h, params: { id: A.id }, expect: 200 });
    await api(one.GET, "/api/v1/locations/nope", { headers: h, params: { id: "nope" }, expect: 404 });
    const lv = await import("@/app/api/v1/stock/levels/route");
    const levelsOut = await api<{ data: Level[] }>(lv.GET, "/api/v1/stock/levels", { headers: h, query: { location: B.id }, expect: 200 });
    expect(levelsOut.body.data.length).toBeGreaterThan(0);
    const tr = await import("@/app/api/v1/transfers/route");
    const created = await api<{ data: Transfer }>(tr.POST, "/api/v1/transfers", { headers: h, json: { from_location_id: A.id, to_location_id: B.id, lines: [{ product_id: widget.id, qty: 1 }] }, expect: 201 });
    const trOne = await import("@/app/api/v1/transfers/[id]/route");
    await api(trOne.GET, `/api/v1/transfers/${created.body.data.id}`, { headers: h, params: { id: created.body.data.id }, expect: 200 });
    const all = await api<{ data: Transfer[] }>(tr.GET, "/api/v1/transfers", { headers: h, expect: 200 });
    expect(all.body.data.length).toBeGreaterThan(1);
  });

  it("agent tools: locations, levels, transfer_stock", async () => {
    const { ensureToolsLoaded } = await import("@/lib/agents/tools");
    await ensureToolsLoaded();
    const { getTool } = await import("@/lib/agents/registry");
    const ctx = { userId: org.dataId, agentId: null, runId: "itest" } as never;
    const locs = await getTool("inventory.locations")!.run(ctx, {} as never);
    expect(locs.ok).toBe(true);
    const moved = await getTool("inventory.transfer_stock")!.run(ctx, { product_id: widget.id, qty: 1, from_location: "Warehouse", to_location: "store", receive_now: true } as never);
    expect(moved.ok).toBe(true);
    await invariant();
  });

  it("PLANS_ENFORCED: Free allows 1 location, so a second is a 402 plan_limit", async () => {
    const subRoute = await import("@/app/api/plans/subscription/route");
    await api(subRoute.GET, "/api/plans/subscription", { expect: 200 });
    await sql(`UPDATE subscriptions SET trial_ends_at = NOW() - INTERVAL '1 day', current_period_end = NOW() - INTERVAL '1 day' WHERE user_id = $1`, [org.dataId]);
    process.env.PLANS_ENFORCED = "true";
    const route = await import("@/app/api/locations/route");
    const blocked = await api<{ error: string; metric: string; limit: number; used: number }>(route.POST, "/api/locations", { json: { name: "Third" }, expect: 402 });
    expect(blocked.body).toMatchObject({ error: "plan_limit", metric: "locations", limit: 1 });
    delete process.env.PLANS_ENFORCED;
  });
});
