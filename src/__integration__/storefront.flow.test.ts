/**
 * Storefront end-to-end: enable storefront → product visible → public catalog →
 * cart add/update (stock caps) → checkout → pending order + invoice + stock
 * reserved → simulated pay → paid + stock consumed + confirmation email →
 * fulfil → second order cancelled (reservation released, invoice voided) →
 * partial refund → public status page via token → abandoned-cart sweep
 * (idempotent) → v1 + staff route 401/403.
 */
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { api, cleanupDataIds, createTestOrg, describeDb, eventsFor, expectEvent, setScope, sql, sqlOne, waitForRows, type TestOrg } from "./setup";

vi.mock("@/lib/auth/scope", () => import("./setup").then((m) => m.scopeMockFactory()));
vi.mock("@/lib/supabase/server", () => import("./setup").then((m) => m.supabaseMockFactory()));

interface Cart { id: string; items: Array<{ id: string; qty: number; line_minor: number }>; units: number; subtotal_minor: number; tax_minor: number; shipping_minor: number; total_minor: number; unavailable: unknown[] }
interface Order { id: string; number: string; status: string; total_minor: number; invoice_id: string | null; contact_id: string | null; consent_marketing: boolean }
interface PublicOrder { number: string; status: string; total_minor: number; shipping_minor: number }

function cookieFrom(res: Response): string {
  const sc = res.headers.get("set-cookie") ?? "";
  const m = sc.match(/(kh_cart_[^=]+=[^;]+)/);
  if (!m) throw new Error(`no cart cookie in: ${sc}`);
  return m[1];
}

describeDb("storefront flow", () => {
  let org: TestOrg;
  let slug: string;
  let tracked: { id: string };
  let service: { id: string };
  let cookie: string;
  let order: Order;
  let statusToken: string;
  let payToken: string;
  let second: Order;
  const shopper = "shopper@example.test";

  beforeAll(async () => {
    org = await createTestOrg("storefront");
    setScope(org);
    const { createProduct } = await import("@/lib/inventory/products");
    tracked = await createProduct(org.dataId, { name: "Widget", sku: "WID-1", kind: "product", unit: "each", unit_price_minor: 1000, cost_minor: 400, currency: "USD", tax_rate_bp: 2000, track_stock: true, stock_on_hand: 5, reorder_point: 1, active: true });
    service = await createProduct(org.dataId, { name: "Gift wrap", sku: null, kind: "service", unit: "each", unit_price_minor: 250, cost_minor: 0, currency: "USD", tax_rate_bp: 0, track_stock: false, stock_on_hand: 0, reorder_point: 0, active: true });
  });
  afterAll(async () => {
    await cleanupDataIds([org.dataId]);
  });

  it("storefront is off by default: public routes 404 until enabled", async () => {
    const shop = await import("@/app/api/shop/[org]/route");
    await api(shop.GET, `/api/shop/${org.slug}`, { params: { org: org.slug }, expect: 404 });
    await api(shop.GET, `/api/shop/no-such-org`, { params: { org: "no-such-org" }, expect: 404 });

    const sf = await import("@/app/api/storefront/route");
    const cur = await api<{ storefront: { enabled: boolean; slug: string } }>(sf.GET, "/api/storefront", { expect: 200 });
    expect(cur.body.storefront.enabled).toBe(false);
    expect(cur.body.storefront.slug).toBe(org.slug);
    const on = await api<{ storefront: { enabled: boolean; slug: string; collect_shipping: boolean }; public_url: string }>(sf.PATCH, "/api/storefront", {
      method: "PATCH", json: { enabled: true, title: "Test Shop", collect_shipping: true, shipping_flat_minor: 500, pickup_enabled: true, terms_md: "Be nice." }, expect: 200,
    });
    expect(on.body.storefront.enabled).toBe(true);
    slug = on.body.storefront.slug;
    expect(on.body.public_url).toContain(`/shop/${slug}`);
    // Unknown keys are rejected.
    await api(sf.PATCH, "/api/storefront", { method: "PATCH", json: { bogus: 1 }, expect: 400 });
  });

  it("lists products on the storefront and exposes them publicly", async () => {
    const sp = await import("@/app/api/storefront/products/route");
    const all = await api<{ products: Array<{ id: string; visible: boolean }> }>(sp.GET, "/api/storefront/products", { expect: 200 });
    expect(all.body.products.map((p) => p.id).sort()).toEqual([tracked.id, service.id].sort());
    expect(all.body.products.every((p) => !p.visible)).toBe(true);
    await api(sp.PUT, "/api/storefront/products", { method: "PUT", json: { product_id: tracked.id, visible: true, sort: 1 }, expect: 200 });
    await api(sp.PUT, "/api/storefront/products", { method: "PUT", json: { product_id: service.id, visible: true, sort: 2, description_md: "Pretty paper" }, expect: 200 });
    await api(sp.PUT, "/api/storefront/products", { method: "PUT", json: { product_id: tracked.id, image_url: "javascript:alert(1)" }, expect: 400 });

    const shop = await import("@/app/api/shop/[org]/route");
    const pub = await api<{ shop: { name: string; collect_shipping: boolean; prices_include_tax: boolean }; items: Array<{ id: string; stock_available: number | null; in_stock: boolean; description: string | null }> }>(shop.GET, `/api/shop/${slug}`, { params: { org: slug }, expect: 200 });
    expect(pub.body.shop.name).toBe("Test Shop");
    expect(pub.body.items).toHaveLength(2);
    const w = pub.body.items.find((i) => i.id === tracked.id);
    expect(w).toMatchObject({ stock_available: 5, in_stock: true });
    expect(pub.body.items.find((i) => i.id === service.id)?.description).toBe("Pretty paper");
  });

  it("cart: add, cap by stock, update, remove; totals via tax engine + shipping", async () => {
    const cart = await import("@/app/api/shop/[org]/cart/route");
    const first = await api<{ cart: Cart }>(cart.GET, `/api/shop/${slug}/cart`, { params: { org: slug }, expect: 200 });
    cookie = cookieFrom(first.res);
    expect(first.body.cart.items).toHaveLength(0);
    const h = { cookie };

    const add = await api<{ cart: Cart }>(cart.POST, `/api/shop/${slug}/cart`, { json: { product_id: tracked.id, qty: 2 }, headers: h, params: { org: slug }, expect: 200 });
    expect(add.body.cart.items[0]).toMatchObject({ id: tracked.id, qty: 2, line_minor: 2000 });
    // 2 + 10 > 5 in stock → 409
    const over = await api<{ error: string }>(cart.POST, `/api/shop/${slug}/cart`, { json: { product_id: tracked.id, qty: 10 }, headers: h, params: { org: slug }, expect: 409 });
    expect(over.body.error).toBe("out_of_stock");
    const set = await api<{ cart: Cart }>(cart.PATCH, `/api/shop/${slug}/cart`, { method: "PATCH", json: { product_id: tracked.id, qty: 3 }, headers: h, params: { org: slug }, expect: 200 });
    expect(set.body.cart.items[0].qty).toBe(3);
    await api(cart.POST, `/api/shop/${slug}/cart`, { json: { product_id: service.id, qty: 1 }, headers: h, params: { org: slug }, expect: 200 });
    const gone = await api<{ cart: Cart }>(cart.DELETE, `/api/shop/${slug}/cart`, { method: "DELETE", json: { product_id: service.id }, headers: h, params: { org: slug }, expect: 200 });
    expect(gone.body.cart.items.map((i) => i.id)).toEqual([tracked.id]);
    const again = await api<{ cart: Cart }>(cart.POST, `/api/shop/${slug}/cart`, { json: { product_id: service.id, qty: 2 }, headers: h, params: { org: slug }, expect: 200 });
    const c = again.body.cart;
    // 3×1000 @20% + 2×250 @0% = 3500 net, 600 tax; shipping 500 (ship by default when the shop collects shipping)
    expect(c).toMatchObject({ units: 5, subtotal_minor: 3500, tax_minor: 600, shipping_minor: 500, total_minor: 4600 });
    // Unknown product → 404
    await api(cart.POST, `/api/shop/${slug}/cart`, { json: { product_id: "nope", qty: 1 }, headers: h, params: { org: slug }, expect: 404 });
    // Another org's cookie is not honoured: a new cart is created.
    const other = await api<{ cart: Cart }>(cart.GET, `/api/shop/${slug}/cart`, { headers: { cookie: `kh_cart_${slug.replace(/[^a-z0-9]/gi, "_")}=bogus-token` }, params: { org: slug }, expect: 200 });
    expect(other.body.cart.items).toHaveLength(0);
  });

  it("checkout creates a pending order, invoice (sent, due now), reservation, contact + consent", async () => {
    const checkout = await import("@/app/api/shop/[org]/checkout/route");
    const bad = await api(checkout.POST, `/api/shop/${slug}/checkout`, { json: { name: "Sam Shopper" }, headers: { cookie }, params: { org: slug }, expect: 400 });
    expect(bad.status).toBe(400);
    const r = await api<{ order: PublicOrder; status_url: string; status_token: string; pay_url: string }>(checkout.POST, `/api/shop/${slug}/checkout`, {
      json: { name: "Sam Shopper", email: shopper, phone: "+15550001", shipping: { line1: "1 Main St", city: "Springfield", country: "US" }, consent: { marketing: true }, notes: "Leave at door" },
      headers: { cookie }, params: { org: slug }, expect: 201,
    });
    expect(r.body.order.status).toBe("pending_payment");
    expect(r.body.order.total_minor).toBe(4600);
    expect(r.body.order.shipping_minor).toBe(500);
    expect(r.body.pay_url).toMatch(/\/p\/pay\//);
    expect(r.body.status_url).toContain(`/shop/${slug}/order/`);
    statusToken = r.body.status_token;
    payToken = r.body.pay_url.split("/p/pay/")[1].split("?")[0];

    const row = await sqlOne<Order & { customer_email: string }>(`SELECT id, number, status, total_minor, invoice_id, contact_id, consent_marketing, customer_email FROM orders WHERE user_id = $1 AND number = $2`, [org.dataId, r.body.order.number]);
    expect(row).toBeTruthy();
    order = { ...row!, total_minor: Number(row!.total_minor) };
    expect(order.number).toMatch(/^ORD-\d{6}$/);
    expect(order.invoice_id).toBeTruthy();
    expect(order.consent_marketing).toBe(true);
    const inv = await sqlOne<{ status: string; total_minor: string; due_at: string | null; contact_id: string | null }>(`SELECT status, total_minor, due_at, contact_id FROM invoices WHERE id = $1`, [order.invoice_id]);
    expect(inv?.status).toBe("sent");
    expect(Number(inv?.total_minor)).toBe(4600);
    expect(inv?.due_at).toBeTruthy();
    expect(inv?.contact_id).toBe(order.contact_id);
    const p = await sqlOne<{ stock_on_hand: number; stock_reserved: number }>(`SELECT stock_on_hand, stock_reserved FROM products WHERE id = $1`, [tracked.id]);
    expect(Number(p?.stock_on_hand)).toBe(5);
    expect(Number(p?.stock_reserved)).toBe(3);
    const reserve = await sql(`SELECT id FROM stock_movements WHERE user_id = $1 AND ref_kind = 'order' AND ref_id = $2 AND kind = 'reserve'`, [org.dataId, order.id]);
    expect(reserve).toHaveLength(1);
    const contact = await sqlOne<{ full_name: string; email: string }>(`SELECT full_name, email FROM crm_contacts WHERE id = $1`, [order.contact_id]);
    expect(contact).toMatchObject({ full_name: "Sam Shopper", email: shopper });
    await waitForRows(`SELECT id FROM consent_records WHERE user_id = $1 AND subject_kind = 'contact' AND subject_id = $2 AND purpose = 'marketing_email' AND status = 'granted'`, [org.dataId, order.contact_id]);
    await expectEvent(org.dataId, "order.created", order.id);
    // The cart is spent: the same cookie now yields an empty cart.
    const cart = await import("@/app/api/shop/[org]/cart/route");
    const after = await api<{ cart: Cart }>(cart.GET, `/api/shop/${slug}/cart`, { headers: { cookie }, params: { org: slug }, expect: 200 });
    expect(after.body.cart.items).toHaveLength(0);
    // Checkout again with the spent cart → 400
    await api(checkout.POST, `/api/shop/${slug}/checkout`, { json: { name: "Sam", email: shopper }, headers: { cookie }, params: { org: slug }, expect: 400 });
  });

  it("simulated payment marks the order paid, consumes stock once and emails a confirmation", async () => {
    const pay = await import("@/app/api/p/pay/[token]/route");
    const r = await api<{ ok: boolean; status: string }>(pay.POST, `/api/p/pay/${payToken}`, { json: { outcome: "success" }, params: { token: payToken }, expect: 200 });
    expect(r.body.status).toBe("paid");
    const o = await sqlOne<{ status: string; paid_at: string | null; payment_ref: string | null }>(`SELECT status, paid_at, payment_ref FROM orders WHERE id = $1`, [order.id]);
    expect(o?.status).toBe("paid");
    expect(o?.paid_at).toBeTruthy();
    expect(o?.payment_ref).toContain("sim_");
    const p = await sqlOne<{ stock_on_hand: number; stock_reserved: number }>(`SELECT stock_on_hand, stock_reserved FROM products WHERE id = $1`, [tracked.id]);
    expect(Number(p?.stock_on_hand)).toBe(2);
    expect(Number(p?.stock_reserved)).toBe(0);
    const consume = await sql(`SELECT id FROM stock_movements WHERE user_id = $1 AND ref_kind = 'invoice' AND ref_id = $2 AND kind = 'consume'`, [org.dataId, order.invoice_id]);
    expect(consume).toHaveLength(1);
    await expectEvent(org.dataId, "order.paid", order.id);
    await expectEvent(org.dataId, "invoice.paid", order.invoice_id!);
    const mail = await waitForRows<{ subject: string; body: string }>(`SELECT subject, body FROM notification_outbox WHERE user_id = $1 AND recipient = $2 AND data LIKE '%order_confirmation%'`, [org.dataId, shopper]);
    expect(mail[0].subject).toContain(order.number);
    expect(mail[0].body).toContain(`/shop/${slug}/order/`);
  });

  it("staff: list/get/fulfil; fulfilment emails the customer; viewer cannot edit", async () => {
    const list = await import("@/app/api/orders/route");
    const byId = await import("@/app/api/orders/[id]/route");
    const all = await api<{ orders: Order[]; counts: Record<string, number> }>(list.GET, "/api/orders", { expect: 200 });
    expect(all.body.orders.map((o) => o.id)).toContain(order.id);
    expect(all.body.counts.paid).toBe(1);
    const paidOnly = await api<{ orders: Order[] }>(list.GET, "/api/orders", { query: { status: "paid", q: "shopper@" }, expect: 200 });
    expect(paidOnly.body.orders).toHaveLength(1);
    await api(list.GET, "/api/orders", { query: { status: "bogus" }, expect: 400 });
    const detail = await api<{ order: Order; invoice: { number: string; status: string } | null; payments: Array<{ status: string }> }>(byId.GET, `/api/orders/${order.id}`, { params: { id: order.id }, expect: 200 });
    expect(detail.body.invoice?.status).toBe("paid");
    expect(detail.body.payments.some((p) => p.status === "succeeded")).toBe(true);

    setScope(org, { role: "viewer", userId: "itest-viewer" });
    await api(byId.PATCH, `/api/orders/${order.id}`, { method: "PATCH", json: { status: "fulfilled" }, params: { id: order.id }, expect: 403 });
    setScope(null);
    await api(byId.GET, `/api/orders/${order.id}`, { params: { id: order.id }, expect: 401 });
    setScope(org);

    const f = await api<{ order: Order }>(byId.PATCH, `/api/orders/${order.id}`, { method: "PATCH", json: { status: "fulfilled" }, params: { id: order.id }, expect: 200 });
    expect(f.body.order.status).toBe("fulfilled");
    await expectEvent(org.dataId, "order.fulfilled", order.id);
    await waitForRows(`SELECT id FROM notification_outbox WHERE user_id = $1 AND recipient = $2 AND data LIKE '%order_fulfilled%'`, [org.dataId, shopper]);
    // Fulfilling twice is idempotent; cancelling a fulfilled order refunds (tested below via refund path first).
    const f2 = await api<{ order: Order }>(byId.PATCH, `/api/orders/${order.id}`, { method: "PATCH", json: { status: "fulfilled" }, params: { id: order.id }, expect: 200 });
    expect(f2.body.order.status).toBe("fulfilled");
  });

  it("a second order cancelled while pending releases its reservation and voids the invoice", async () => {
    const cart = await import("@/app/api/shop/[org]/cart/route");
    const checkout = await import("@/app/api/shop/[org]/checkout/route");
    const c = await api<{ cart: Cart }>(cart.POST, `/api/shop/${slug}/cart`, { json: { product_id: tracked.id, qty: 2 }, params: { org: slug }, expect: 200 });
    const ck = cookieFrom(c.res);
    // pickup (no shipping) → no shipping charge; existing contact is matched, not duplicated, and its consent is untouched
    const r = await api<{ order: PublicOrder }>(checkout.POST, `/api/shop/${slug}/checkout`, { json: { name: "Sam Shopper", email: shopper, consent: { marketing: false } }, headers: { cookie: ck }, params: { org: slug }, expect: 201 });
    expect(r.body.order.shipping_minor).toBe(0);
    expect(r.body.order.total_minor).toBe(2400);
    const row = await sqlOne<Order>(`SELECT id, number, status, total_minor, invoice_id, contact_id, consent_marketing FROM orders WHERE user_id = $1 AND number = $2`, [org.dataId, r.body.order.number]);
    second = row!;
    expect(second.contact_id).toBe(order.contact_id);
    const contacts = await sql(`SELECT id FROM crm_contacts WHERE user_id = $1 AND lower(email) = $2`, [org.dataId, shopper]);
    expect(contacts).toHaveLength(1);
    const consents = await sql(`SELECT id FROM consent_records WHERE user_id = $1 AND subject_id = $2 AND purpose = 'marketing_email'`, [org.dataId, order.contact_id]);
    expect(consents).toHaveLength(1);
    let p = await sqlOne<{ stock_reserved: number }>(`SELECT stock_reserved FROM products WHERE id = $1`, [tracked.id]);
    expect(Number(p?.stock_reserved)).toBe(2);
    // Stock is now exhausted (2 on hand, 2 reserved): a third shopper is refused.
    const c3 = await api<{ error: string }>(cart.POST, `/api/shop/${slug}/cart`, { json: { product_id: tracked.id, qty: 1 }, params: { org: slug }, expect: 409 });
    expect(c3.body.error).toBe("out_of_stock");

    const byId = await import("@/app/api/orders/[id]/route");
    const x = await api<{ order: Order; released: number; refunded_minor: number }>(byId.PATCH, `/api/orders/${second.id}`, { method: "PATCH", json: { status: "cancelled", reason: "changed mind" }, params: { id: second.id }, expect: 200 });
    expect(x.body.order.status).toBe("cancelled");
    expect(x.body.released).toBe(1);
    expect(x.body.refunded_minor).toBe(0);
    p = await sqlOne<{ stock_reserved: number }>(`SELECT stock_reserved FROM products WHERE id = $1`, [tracked.id]);
    expect(Number(p?.stock_reserved)).toBe(0);
    const inv = await sqlOne<{ status: string }>(`SELECT status FROM invoices WHERE id = $1`, [second.invoice_id]);
    expect(inv?.status).toBe("void");
    await expectEvent(org.dataId, "order.cancelled", second.id);
    // Terminal: cannot fulfil
    await api(byId.PATCH, `/api/orders/${second.id}`, { method: "PATCH", json: { status: "fulfilled" }, params: { id: second.id }, expect: 400 });
  });

  it("refund path: partial refund through the provider, then cancel-with-refund closes the order", async () => {
    const refund = await import("@/app/api/orders/[id]/refund/route");
    await api(refund.POST, `/api/orders/${second.id}/refund`, { json: { amount_minor: 100 }, params: { id: second.id }, expect: 400 });
    const r = await api<{ order: Order; refunded_minor: number }>(refund.POST, `/api/orders/${order.id}/refund`, { json: { amount_minor: 600, reason: "damaged wrap" }, params: { id: order.id }, expect: 201 });
    expect(r.body.refunded_minor).toBe(600);
    expect(r.body.order.status).toBe("fulfilled");
    const pay = await sqlOne<{ refunded_minor: string }>(`SELECT refunded_minor FROM invoice_payments WHERE invoice_id = $1 AND status = 'succeeded'`, [order.invoice_id]);
    expect(Number(pay?.refunded_minor)).toBe(600);
    const byId = await import("@/app/api/orders/[id]/route");
    const x = await api<{ order: Order; refunded_minor: number }>(byId.PATCH, `/api/orders/${order.id}`, { method: "PATCH", json: { status: "cancelled", restock: true }, params: { id: order.id }, expect: 200 });
    expect(x.body.order.status).toBe("refunded");
    expect(x.body.refunded_minor).toBe(4000);
    const p = await sqlOne<{ stock_on_hand: number }>(`SELECT stock_on_hand FROM products WHERE id = $1`, [tracked.id]);
    expect(Number(p?.stock_on_hand)).toBe(5);
  });

  it("public order status via token (org-bound), pay-again refused once not pending", async () => {
    const st = await import("@/app/api/shop/[org]/orders/[token]/route");
    const r = await api<{ order: PublicOrder & { customer_email: string }; can_pay: boolean }>(st.GET, `/api/shop/${slug}/orders/${statusToken}`, { params: { org: slug, token: statusToken }, expect: 200 });
    expect(r.body.order.number).toBe(order.number);
    expect(r.body.order.status).toBe("refunded");
    expect(r.body.can_pay).toBe(false);
    expect(JSON.stringify(r.body.order)).not.toContain(order.id);
    await api(st.GET, `/api/shop/${slug}/orders/not-a-token`, { params: { org: slug, token: "not-a-token" }, expect: 404 });
    await api(st.POST, `/api/shop/${slug}/orders/${statusToken}`, { method: "POST", params: { org: slug, token: statusToken }, expect: 409 });
    // Token from another org's slug → 404
    const other = await createTestOrg("storefront-other");
    try {
      await sql(`INSERT INTO storefronts (user_id, enabled, slug) VALUES ($1, TRUE, $2)`, [other.dataId, other.slug]);
      await api(st.GET, `/api/shop/${other.slug}/orders/${statusToken}`, { params: { org: other.slug, token: statusToken }, expect: 404 });
    } finally {
      await cleanupDataIds([other.dataId]);
    }
  });

  it("abandoned cart sweep emits once per cart (idempotent) with the matched contact", async () => {
    const cart = await import("@/app/api/shop/[org]/cart/route");
    const c = await api<{ cart: Cart }>(cart.POST, `/api/shop/${slug}/cart`, { json: { product_id: service.id, qty: 1 }, params: { org: slug }, expect: 200 });
    const ck = cookieFrom(c.res);
    await api(cart.PATCH, `/api/shop/${slug}/cart`, { method: "PATCH", json: { email: shopper }, headers: { cookie: ck }, params: { org: slug }, expect: 200 });
    const { abandonedCartSweep } = await import("@/lib/storefront/cart");
    // Fresh cart: not abandoned yet.
    expect((await abandonedCartSweep(50)).emitted).toBe(0);
    await sql(`UPDATE carts SET updated_at = NOW() - INTERVAL '3 hours' WHERE id = $1`, [c.body.cart.id]);
    expect((await abandonedCartSweep(50)).emitted).toBe(1);
    expect((await abandonedCartSweep(50)).emitted).toBe(0);
    const evts = await eventsFor(org.dataId, "cart.abandoned", c.body.cart.id);
    expect(evts).toHaveLength(1);
    const data = JSON.parse(evts[0].data ?? "{}") as { email: string; contact_id: string | null; units: number; shop_url: string | null };
    expect(data).toMatchObject({ email: shopper, contact_id: order.contact_id, units: 1 });
    expect(data.shop_url).toContain(`/shop/${slug}/cart`);
  });

  it("API v1: orders list/get/fulfil with scopes; storefront products via registry", async () => {
    const keys = await import("@/app/api/api-keys/route");
    const full = await api<{ key: string }>(keys.POST, "/api/api-keys", { json: { name: "shop full", scopes: ["write:billing"] }, expect: 201 });
    const ro = await api<{ key: string }>(keys.POST, "/api/api-keys", { json: { name: "shop crm", scopes: ["read:crm"] }, expect: 201 });
    const bearer = (k: string) => ({ authorization: `Bearer ${k}` });
    const v1 = await import("@/app/api/v1/orders/route");
    const v1id = await import("@/app/api/v1/orders/[id]/route");
    const v1fulfil = await import("@/app/api/v1/orders/[id]/fulfil/route");
    const v1sp = await import("@/app/api/v1/storefront/products/route");
    await api(v1.GET, "/api/v1/orders", { expect: 401 });
    await api(v1.GET, "/api/v1/orders", { headers: bearer(ro.body.key), expect: 403 });
    const list = await api<{ data: Order[] }>(v1.GET, "/api/v1/orders", { query: { status: "refunded" }, headers: bearer(full.body.key), expect: 200 });
    expect(list.body.data.map((o) => o.id)).toEqual([order.id]);
    const one = await api<{ data: Order }>(v1id.GET, `/api/v1/orders/${order.id}`, { params: { id: order.id }, headers: bearer(full.body.key), expect: 200 });
    expect(one.body.data.number).toBe(order.number);
    // Refunded order cannot be fulfilled → 422
    await api(v1fulfil.POST, `/api/v1/orders/${order.id}/fulfil`, { method: "POST", params: { id: order.id }, headers: bearer(full.body.key), expect: 422 });
    const sp = await api<{ data: Array<{ id: string; visible: boolean }> }>(v1sp.GET, "/api/v1/storefront/products", { headers: bearer(full.body.key), expect: 200 });
    expect(sp.body.data.filter((p) => p.visible)).toHaveLength(2);
    const hide = await api<{ data: { visible: boolean } }>(v1sp.PATCH, "/api/v1/storefront/products", { method: "PATCH", json: { product_id: service.id, visible: false }, headers: bearer(full.body.key), expect: 200 });
    expect(hide.body.data.visible).toBe(false);
  });
});
