/**
 * Shipping end-to-end: storefront order → shipping rules + checkout quote → paid →
 * shipment via the simulated carrier → label PDF attachment → tracking advance →
 * delivered email + order.delivered (idempotent) → public tracking token →
 * customer return → approve → label → receive + restock → refund (capped) →
 * org isolation → plan gate → v1 + 401/403.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { api, cleanupDataIds, createTestOrg, describeDb, expectEvent, setScope, sql, sqlOne, waitForRows, type TestOrg } from "./setup";

vi.mock("@/lib/auth/scope", () => import("./setup").then((m) => m.scopeMockFactory()));
vi.mock("@/lib/supabase/server", () => import("./setup").then((m) => m.supabaseMockFactory()));
process.env.ATTACHMENTS_LOCAL_DIR = mkdtempSync(join(tmpdir(), "kh-ship-"));

interface Shipment { id: string; status: string; tracking_number: string | null; label_attachment_id: string | null; carrier: string | null }
const cookieFrom = (res: Response): string => (res.headers.get("set-cookie") ?? "").match(/(kh_cart_[^=]+=[^;]+)/)?.[1] ?? "";

describeDb("shipping flow", () => {
  let org: TestOrg;
  let other: TestOrg;
  let slug: string;
  let product: { id: string };
  let orderId: string;
  let statusToken: string;
  let payToken: string;
  let shipment: Shipment;
  let returnId: string;
  const shopper = "ship-shopper@example.test";

  beforeAll(async () => {
    org = await createTestOrg("shipping");
    other = await createTestOrg("shipping-other");
    setScope(org);
    const { createProduct } = await import("@/lib/inventory/products");
    product = await createProduct(org.dataId, { name: "Heavy Widget", sku: "HW-1", kind: "product", unit: "each", unit_price_minor: 2000, cost_minor: 500, currency: "USD", tax_rate_bp: 0, track_stock: true, stock_on_hand: 10, reorder_point: 1, active: true });
    await sql(`UPDATE products SET weight_grams = 700 WHERE id = $1`, [product.id]);
  });
  afterAll(async () => {
    await cleanupDataIds([org.dataId, other.dataId]);
  });

  it("rules + ship-from are configured; rule validation rejects bad config", async () => {
    const sf = await import("@/app/api/storefront/route");
    const on = await api<{ storefront: { slug: string } }>(sf.PATCH, "/api/storefront", { method: "PATCH", json: { enabled: true, title: "Ship Shop", collect_shipping: true, shipping_flat_minor: 999, pickup_enabled: true }, expect: 200 });
    slug = on.body.storefront.slug;
    const sp = await import("@/app/api/storefront/products/route");
    await api(sp.PUT, "/api/storefront/products", { method: "PUT", json: { product_id: product.id, visible: true, sort: 1 }, expect: 200 });
    const rules = await import("@/app/api/shipping/rules/route");
    await api(rules.POST, "/api/shipping/rules", { json: { name: "Bad", kind: "flat", config: { price_minor: -1 } }, expect: 400 });
    await api(rules.POST, "/api/shipping/rules", { json: { name: "US flat", kind: "flat", config: { price_minor: 450, days_min: 3, days_max: 5 }, countries: ["US"] }, expect: 201 });
    await api(rules.POST, "/api/shipping/rules", { json: { name: "Carrier rates", kind: "carrier_calculated", config: { markup_pct: 10 }, countries: ["US"] }, expect: 201 });
    await api(rules.POST, "/api/shipping/rules", { json: { name: "Free over 100", kind: "free_over", config: { threshold_minor: 10000 } }, expect: 201 });
    const conns = await import("@/app/api/shipping/connections/route");
    await api(conns.PUT, "/api/shipping/connections", { method: "PUT", json: { provider: "simulated", ship_from: { name: "Warehouse", line1: "9 Dock Rd", city: "Portville", country: "US" }, default_package: { weight_grams: 500 } }, expect: 200 });
    const list = await api<{ connections: Array<{ provider: string; available: boolean; ship_from: unknown }> }>(conns.GET, "/api/shipping/connections", { expect: 200 });
    expect(list.body.connections.find((c) => c.provider === "simulated")).toMatchObject({ available: true });
    expect(JSON.stringify(list.body)).not.toContain("api_key");
  });

  it("checkout quote returns rule + carrier options; order stores the chosen method; price is server-derived", async () => {
    const cart = await import("@/app/api/shop/[org]/cart/route");
    const first = await api(cart.GET, `/api/shop/${slug}/cart`, { params: { org: slug }, expect: 200 });
    const cookie = cookieFrom(first.res);
    await api(cart.POST, `/api/shop/${slug}/cart`, { json: { product_id: product.id, qty: 2 }, headers: { cookie }, params: { org: slug }, expect: 200 });
    const q = await import("@/app/api/shop/[org]/shipping-quote/route");
    await api(q.POST, `/api/shop/${slug}/shipping-quote`, { json: { address: { line1: "1 Main", city: "Springfield" } }, headers: { cookie }, params: { org: slug }, expect: 400 });
    const quote = await api<{ rules_active: boolean; options: Array<{ id: string; label: string; price_minor: number }> }>(q.POST, `/api/shop/${slug}/shipping-quote`, { json: { address: { line1: "1 Main", city: "Springfield", country: "US" } }, headers: { cookie }, params: { org: slug }, expect: 200 });
    expect(quote.body.rules_active).toBe(true);
    const labels = quote.body.options.map((o) => o.label);
    expect(labels).toContain("US flat");
    expect(labels).toContain("Standard");
    expect(labels).not.toContain("Free over 100"); // subtotal 4000 < 10000
    const flat = quote.body.options.find((o) => o.label === "US flat")!;
    expect(flat.price_minor).toBe(450);

    const checkout = await import("@/app/api/shop/[org]/checkout/route");
    await api(checkout.POST, `/api/shop/${slug}/checkout`, { json: { name: "Sam", email: shopper, shipping: { line1: "1 Main", city: "Springfield", country: "US" }, shipping_option_id: "rule:forged" }, headers: { cookie }, params: { org: slug }, expect: 400 });
    const r = await api<{ order: { number: string; shipping_minor: number; total_minor: number }; status_token: string; pay_url: string }>(checkout.POST, `/api/shop/${slug}/checkout`, {
      json: { name: "Sam Shopper", email: shopper, shipping: { line1: "1 Main", city: "Springfield", country: "US" }, shipping_option_id: flat.id }, headers: { cookie }, params: { org: slug }, expect: 201,
    });
    expect(r.body.order.shipping_minor).toBe(450);
    expect(r.body.order.total_minor).toBe(4450);
    statusToken = r.body.status_token;
    payToken = r.body.pay_url.split("/p/pay/")[1].split("?")[0];
    const row = await sqlOne<{ id: string; shipping_method: string | null }>(`SELECT id, shipping_method FROM orders WHERE user_id = $1 AND number = $2`, [org.dataId, r.body.order.number]);
    orderId = row!.id;
    expect(row!.shipping_method).toBe("US flat");
  });

  it("paid order → shipment via simulated carrier with a label PDF attachment", async () => {
    const pay = await import("@/app/api/p/pay/[token]/route");
    await api(pay.POST, `/api/p/pay/${payToken}`, { json: { outcome: "success" }, params: { token: payToken }, expect: 200 });
    const route = await import("@/app/api/shipping/shipments/route");
    await api(route.POST, "/api/shipping/shipments", { json: { order_id: "nope" }, expect: 404 });
    const rates = await import("@/app/api/shipping/rates/route");
    const rr = await api<{ rates: Array<{ id: string; service: string }>; weight_grams: number }>(rates.POST, "/api/shipping/rates", { json: { order_id: orderId }, expect: 200 });
    expect(rr.body.weight_grams).toBe(1400);
    expect(rr.body.rates).toHaveLength(3);
    const made = await api<{ shipments: Shipment[] }>(route.POST, "/api/shipping/shipments", { json: { order_id: orderId, rate_id: rr.body.rates[0].id }, expect: 201 });
    shipment = made.body.shipments[0];
    expect(shipment.status).toBe("label_purchased");
    expect(shipment.tracking_number).toMatch(/^KH\d{12}$/);
    expect(shipment.label_attachment_id).toBeTruthy();
    await expectEvent(org.dataId, "shipment.created", shipment.id);
    // a second shipment for the same order is refused unless additional
    await api(route.POST, "/api/shipping/shipments", { json: { order_id: orderId }, expect: 409 });
    const label = await import("@/app/api/shipping/shipments/[id]/label/route");
    const pdf = await api<string>(label.GET, `/api/shipping/shipments/${shipment.id}/label`, { params: { id: shipment.id }, expect: 200 });
    expect(pdf.res.headers.get("content-type")).toBe("application/pdf");
    expect(pdf.body).toContain("%PDF-1.4");
    const slip = await import("@/app/api/shipping/shipments/[id]/packing-slip/route");
    await api(slip.GET, `/api/shipping/shipments/${shipment.id}/packing-slip`, { params: { id: shipment.id }, expect: 200 });
  });

  it("tracking advance is idempotent, ends delivered, emails the customer and emits order.delivered", async () => {
    const { advanceSimulated, ingestTrackingEvent } = await import("@/lib/shipping/tracking");
    const future = new Date(Date.now() + 30 * 86_400_000);
    await advanceSimulated(100, { now: future });
    const s = await sqlOne<{ status: string; delivered_at: string | null }>(`SELECT status, delivered_at FROM shipments WHERE id = $1`, [shipment.id]);
    expect(s?.status).toBe("delivered");
    expect(s?.delivered_at).toBeTruthy();
    const n1 = await sql(`SELECT 1 FROM shipment_events WHERE shipment_id = $1`, [shipment.id]);
    await advanceSimulated(100, { now: future });
    expect(await sql(`SELECT 1 FROM shipment_events WHERE shipment_id = $1`, [shipment.id])).toHaveLength(n1.length);
    // a late in-transit scan never regresses delivered
    const r = await ingestTrackingEvent(org.dataId, shipment.id, { status: "in_transit", description: "late", location: null, occurred_at: new Date().toISOString() });
    expect(r.status).toBe("delivered");
    await expectEvent(org.dataId, "shipment.delivered", shipment.id);
    await expectEvent(org.dataId, "order.delivered", orderId);
    const o = await sqlOne<{ status: string }>(`SELECT status FROM orders WHERE id = $1`, [orderId]);
    expect(o?.status).toBe("fulfilled");
    for (const kind of ["shipment_shipped", "shipment_out_for_delivery", "shipment_delivered"]) {
      expect(await waitForRows(`SELECT 1 FROM notification_outbox WHERE user_id = $1 AND recipient = $2 AND data LIKE $3`, [org.dataId, shopper, `%${kind}%`])).toHaveLength(1);
    }
    // silent fulfilment: no generic "on its way" email was sent
    expect(await sql(`SELECT 1 FROM notification_outbox WHERE user_id = $1 AND data LIKE '%order_fulfilled%'`, [org.dataId])).toHaveLength(0);
  });

  it("public tracking token is recipient-bound; order token also resolves; foreign/bad tokens do not", async () => {
    const mail = await sqlOne<{ data: string }>(`SELECT data FROM notification_outbox WHERE user_id = $1 AND data LIKE '%shipment_delivered%' LIMIT 1`, [org.dataId]);
    const url = (JSON.parse(mail!.data) as { url: string }).url;
    const token = url.split("/track/")[1];
    const tok = await sqlOne<{ recipient: string | null; kind: string }>(`SELECT recipient, kind FROM share_tokens WHERE kind = 'shipment' AND entity_id = $1 LIMIT 1`, [shipment.id]);
    expect(tok).toMatchObject({ recipient: shopper, kind: "shipment" });
    const { resolveTracking } = await import("@/lib/shipping/public");
    const t = await resolveTracking(token);
    expect(t?.shipments[0].status).toBe("delivered");
    expect(t?.shipments[0].events.length).toBeGreaterThan(2);
    expect(t?.shipments[0].can_download_label).toBe(false);
    expect((await resolveTracking(statusToken))?.kind).toBe("order");
    expect(await resolveTracking("not-a-token")).toBeNull();
    // order status API exposes shipments + return info
    const ord = await import("@/app/api/shop/[org]/orders/[token]/route");
    const view = await api<{ shipments: unknown[]; returns: { eligible: boolean } | null }>(ord.GET, `/api/shop/${slug}/orders/${statusToken}`, { params: { org: slug, token: statusToken }, expect: 200 });
    expect(view.body.shipments).toHaveLength(1);
    expect(view.body.returns?.eligible).toBe(true);
  });

  it("customer return: window/quantity enforced, staff approve → label → receive+restock → capped refund", async () => {
    const ret = await import("@/app/api/shop/[org]/orders/[token]/returns/route");
    const p = { org: slug, token: statusToken };
    await api(ret.POST, `/api/shop/${slug}/orders/${statusToken}/returns`, { json: { reason: "broken", items: [{ product_id: product.id, qty: 5 }] }, params: p, expect: 400 });
    await api(ret.POST, `/api/shop/${slug}/orders/${statusToken}/returns`, { json: { reason: "broken", items: [{ product_id: "alien", qty: 1 }] }, params: p, expect: 400 });
    const made = await api<{ return: { id: string; status: string } }>(ret.POST, `/api/shop/${slug}/orders/${statusToken}/returns`, { json: { reason: "arrived broken", items: [{ product_id: product.id, qty: 1 }] }, params: p, expect: 201 });
    returnId = made.body.return.id;
    await expectEvent(org.dataId, "return.requested", returnId);
    // the same unit cannot be returned twice; the other unit still can
    await api(ret.POST, `/api/shop/${slug}/orders/${statusToken}/returns`, { json: { reason: "x", items: [{ product_id: product.id, qty: 2 }] }, params: p, expect: 400 });
    // wrong-org token
    await api(ret.POST, `/api/shop/${slug}/orders/bogus/returns`, { json: { reason: "x", items: [{ product_id: product.id, qty: 1 }] }, params: { org: slug, token: "bogus" }, expect: 404 });

    const one = await import("@/app/api/shipping/returns/[id]/route");
    const act = (body: Record<string, unknown>, expectStatus = 200) => api<{ return: { status: string; refund_minor: number }; refunded_minor?: number }>(one.POST, `/api/shipping/returns/${returnId}`, { json: body, params: { id: returnId }, expect: expectStatus });
    await act({ action: "refund" }, 409); // not received yet
    await act({ action: "receive" }, 409); // not approved yet
    expect((await act({ action: "approve", notes: "ok" })).body.return.status).toBe("approved");
    await expectEvent(org.dataId, "return.approved", returnId);
    expect((await act({ action: "label", provider: "simulated" })).body.return.status).toBe("label_sent");
    const rs = await sqlOne<{ id: string; status: string }>(`SELECT id, status FROM shipments WHERE return_id = $1`, [returnId]);
    expect(rs?.status).toBe("label_purchased");
    const before = await sqlOne<{ stock_on_hand: number }>(`SELECT stock_on_hand FROM products WHERE id = $1`, [product.id]);
    expect((await act({ action: "receive", restock: true })).body.return.status).toBe("received");
    const after = await sqlOne<{ stock_on_hand: number }>(`SELECT stock_on_hand FROM products WHERE id = $1`, [product.id]);
    expect(Number(after?.stock_on_hand)).toBe(Number(before?.stock_on_hand) + 1);
    // order total 4450 (4000 goods + 450 shipping): a huge requested amount is capped to what is refundable
    const done = await act({ action: "refund", amount_minor: 900_000 });
    expect(done.body.return.status).toBe("refunded");
    expect(done.body.refunded_minor).toBe(4450);
    await expectEvent(org.dataId, "return.refunded", returnId);
    const pay = await sqlOne<{ refunded_minor: string }>(`SELECT p.refunded_minor FROM invoice_payments p JOIN orders o ON o.invoice_id = p.invoice_id WHERE o.id = $1`, [orderId]);
    expect(Number(pay?.refunded_minor)).toBe(4450);
    await act({ action: "refund" }, 200); // already refunded: idempotent
    expect(await sql(`SELECT 1 FROM notification_outbox WHERE user_id = $1 AND data LIKE '%return_refunded%'`, [org.dataId])).toHaveLength(1);
  });

  it("org isolation: another org cannot see or act on shipments, returns or rules", async () => {
    setScope(other);
    const one = await import("@/app/api/shipping/shipments/[id]/route");
    await api(one.GET, `/api/shipping/shipments/${shipment.id}`, { params: { id: shipment.id }, expect: 404 });
    const list = await import("@/app/api/shipping/shipments/route");
    const mine = await api<{ shipments: unknown[] }>(list.GET, "/api/shipping/shipments", { expect: 200 });
    expect(mine.body.shipments).toHaveLength(0);
    const ret = await import("@/app/api/shipping/returns/[id]/route");
    await api(ret.POST, `/api/shipping/returns/${returnId}`, { json: { action: "close" }, params: { id: returnId }, expect: 404 });
    const rules = await import("@/app/api/shipping/rules/route");
    expect((await api<{ rules: unknown[] }>(rules.GET, "/api/shipping/rules", { expect: 200 })).body.rules).toHaveLength(0);
    const { quoteCacheKeys } = await import("@/lib/shipping/quote");
    expect(quoteCacheKeys().every((k) => k.startsWith(`${org.dataId}:`) || k.startsWith(`${other.dataId}:`))).toBe(true);
    // viewer can read but not buy
    setScope(org, { role: "viewer", userId: "itest-viewer" });
    await api(list.POST, "/api/shipping/shipments", { json: { order_id: orderId, manual: { carrier: "X" } }, expect: 403 });
    setScope(null);
    await api(list.GET, "/api/shipping/shipments", { expect: 401 });
    setScope(org);
  });

  it("plan gate: Free plan cannot buy labels or connect carriers, manual shipments stay allowed", async () => {
    await import("@/app/api/plans/subscription/route").then((m) => api(m.GET, "/api/plans/subscription", { expect: 200 }));
    await sql(`UPDATE subscriptions SET trial_ends_at = NOW() - INTERVAL '1 day', current_period_end = NOW() - INTERVAL '1 day' WHERE user_id = $1`, [org.dataId]);
    const prev = process.env.PLANS_ENFORCED;
    process.env.PLANS_ENFORCED = "true";
    try {
      const list = await import("@/app/api/shipping/shipments/route");
      const gated = await api<{ error: string; kind: string }>(list.POST, "/api/shipping/shipments", { json: { order_id: orderId, additional: true }, expect: 402 });
      expect(gated.body).toMatchObject({ error: "plan_limit", kind: "feature" });
      const conns = await import("@/app/api/shipping/connections/route");
      await api(conns.PUT, "/api/shipping/connections", { method: "PUT", json: { provider: "easypost", api_key: "ep_test_key_123456" }, expect: 402 });
      // Manual shipments skip the plan gate; this order is fully refunded so the order-state check answers instead.
      await api(list.POST, "/api/shipping/shipments", { json: { order_id: orderId, additional: true, manual: { carrier: "Local courier", tracking_number: "LC-1" } }, expect: 409 });
    } finally {
      if (prev === undefined) delete process.env.PLANS_ENFORCED;
      else process.env.PLANS_ENFORCED = prev;
    }
  });

  it("api v1: 401 without key, 403 wrong scope, list/get with the right scope", async () => {
    const keys = await import("@/app/api/api-keys/route");
    const full = await api<{ key: string }>(keys.POST, "/api/api-keys", { json: { name: "ship", scopes: ["read:billing"] }, expect: 201 });
    const crm = await api<{ key: string }>(keys.POST, "/api/api-keys", { json: { name: "crm", scopes: ["read:crm"] }, expect: 201 });
    const v1 = await import("@/app/api/v1/shipments/route");
    await api(v1.GET, "/api/v1/shipments", { expect: 401 });
    await api(v1.GET, "/api/v1/shipments", { headers: { authorization: `Bearer ${crm.body.key}` }, expect: 403 });
    const ok = await api<{ data: Array<{ id: string }> }>(v1.GET, "/api/v1/shipments", { headers: { authorization: `Bearer ${full.body.key}` }, expect: 200 });
    expect(ok.body.data.map((s) => s.id)).toContain(shipment.id);
    const one = await import("@/app/api/v1/shipments/[id]/route");
    await api(one.GET, `/api/v1/shipments/${shipment.id}`, { headers: { authorization: `Bearer ${full.body.key}` }, params: { id: shipment.id }, expect: 200 });
    const rets = await import("@/app/api/v1/returns/route");
    const rl = await api<{ data: Array<{ id: string; status: string }> }>(rets.GET, "/api/v1/returns", { headers: { authorization: `Bearer ${full.body.key}` }, expect: 200 });
    expect(rl.body.data[0]).toMatchObject({ id: returnId, status: "refunded" });
  });
});
