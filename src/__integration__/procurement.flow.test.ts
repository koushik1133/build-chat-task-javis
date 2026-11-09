/**
 * Procurement end-to-end: supplier → PO (totals) → send (event + outbox) →
 * partial receive (stock + weighted cost) → full receive → bill from PO →
 * payment (expense row, status) → AP aging → reorder suggestion → draft POs
 * → v1 endpoints (401 / 403 / 200).
 */
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { api, call, cleanupDataIds, createTestOrg, describeDb, expectEvent, req, setScope, sql, sqlOne, waitForRows, type TestOrg } from "./setup";

vi.mock("@/lib/auth/scope", () => import("./setup").then((m) => m.scopeMockFactory()));
vi.mock("@/lib/supabase/server", () => import("./setup").then((m) => m.supabaseMockFactory()));

interface Supplier { id: string; name: string; payment_terms_days: number; currency: string }
interface Product { id: string; name: string; stock_on_hand: number; stock_available: number; cost_minor: number; last_cost_minor: number | null; low_stock: boolean; preferred_supplier_id: string | null }
interface PO { id: string; number: string; status: string; subtotal_minor: number; tax_minor: number; total_minor: number; currency: string; supplier_id: string; items: Array<{ product_id?: string; qty: number }> }
interface Bill { id: string; number: string; status: string; total_minor: number; paid_minor: number; outstanding_minor: number; due_at: string | null; overdue: boolean; purchase_order_id: string | null }
interface Aging { rows: Array<{ supplier_id: string; total_minor: number; buckets: Record<string, number> }>; total_minor: number }

describeDb("procurement flow", () => {
  let org: TestOrg;
  let supplier: Supplier;
  let widget: Product;
  let gadget: Product;
  let po: PO;
  let bill: Bill;
  let apiKeyToken: string | null = null;

  beforeAll(async () => {
    org = await createTestOrg("procurement");
    setScope(org);
  });
  afterAll(async () => {
    await cleanupDataIds([org.dataId]);
  });

  it("creates a supplier with terms and tracked products with a preferred supplier", async () => {
    const suppliers = await import("@/app/api/suppliers/route");
    await api(suppliers.POST, "/api/suppliers", { json: { name: "x", bogus: 1 }, expect: 400 });
    supplier = (await api<{ supplier: Supplier }>(suppliers.POST, "/api/suppliers", {
      json: { name: "Acme Parts", email: "orders@acme.test", payment_terms_days: 14, currency: "USD", address: { line1: "1 Depot Rd", city: "Austin", country: "US" }, tax_number: "US-TAX-1" },
      expect: 201,
    })).body.supplier;
    expect(supplier.payment_terms_days).toBe(14);
    const list = await api<{ suppliers: Supplier[] }>(suppliers.GET, "/api/suppliers", { query: { q: "acme" }, expect: 200 });
    expect(list.body.suppliers.map((s) => s.id)).toContain(supplier.id);

    const products = await import("@/app/api/products/route");
    widget = (await api<{ product: Product }>(products.POST, "/api/products", {
      json: { name: "Widget", sku: "WID-1", track_stock: true, stock_on_hand: 10, cost_minor: 100, unit_price_minor: 300, reorder_point: 5, preferred_supplier_id: supplier.id },
      expect: 201,
    })).body.product;
    gadget = (await api<{ product: Product }>(products.POST, "/api/products", {
      json: { name: "Gadget", sku: "GAD-1", track_stock: true, stock_on_hand: 0, cost_minor: 0, unit_price_minor: 900, reorder_point: 2, preferred_supplier_id: supplier.id },
      expect: 201,
    })).body.product;
    expect(widget.preferred_supplier_id).toBe(supplier.id);
    expect(gadget.low_stock).toBe(true);
  });

  it("drafts a purchase order with tax-engine totals and a PO number", async () => {
    const pos = await import("@/app/api/purchase-orders/route");
    po = (await api<{ purchase_order: PO }>(pos.POST, "/api/purchase-orders", {
      json: {
        supplier_id: supplier.id,
        items: [
          { description: "Widget (WID-1)", qty: 10, unit_minor: 200, tax_rate_bp: 1000, product_id: widget.id },
          { description: "Gadget (GAD-1)", qty: 4, unit_minor: 500, tax_rate_bp: 0, product_id: gadget.id },
          { description: "Freight", qty: 1, unit_minor: 1500 },
        ],
        expected_at: new Date(Date.now() + 7 * 86_400_000).toISOString(),
      },
      expect: 201,
    })).body.purchase_order;
    expect(po.number).toMatch(/^PO-\d{6}$/);
    expect(po.status).toBe("draft");
    expect(po.subtotal_minor).toBe(2000 + 2000 + 1500);
    expect(po.tax_minor).toBe(200);
    expect(po.total_minor).toBe(5700);
    expect(po.currency).toBe("USD");

    // Receiving a draft is refused.
    const receive = await import("@/app/api/purchase-orders/[id]/receive/route");
    await api(receive.POST, `/api/purchase-orders/${po.id}/receive`, { json: { lines: [{ product_id: widget.id, qty: 1 }] }, params: { id: po.id }, expect: 400 });

    const pdf = await import("@/app/api/purchase-orders/[id]/pdf/route");
    const out = await call(pdf.GET, req(`/api/purchase-orders/${po.id}/pdf`), { id: po.id }, 200);
    expect(out.text.startsWith("%PDF")).toBe(true);
    expect(out.text).toContain("PURCHASE ORDER");
    expect(out.text).toContain("Austin");
  });

  it("sends the order: status sent, supplier emailed, event emitted", async () => {
    const send = await import("@/app/api/purchase-orders/[id]/send/route");
    const s = await api<{ purchase_order: PO; to: string }>(send.POST, `/api/purchase-orders/${po.id}/send`, { json: {}, params: { id: po.id }, expect: 200 });
    expect(s.body.purchase_order.status).toBe("sent");
    expect(s.body.to).toBe("orders@acme.test");
    const mail = await waitForRows(`SELECT id FROM notification_outbox WHERE user_id = $1 AND recipient = 'orders@acme.test' AND subject LIKE '%' || $2 || '%'`, [org.dataId, po.number]);
    expect(mail.length).toBeGreaterThan(0);
    await expectEvent(org.dataId, "purchase_order.sent", po.id);
  });

  it("partial receipt moves stock, re-costs (weighted average) and marks partially_received", async () => {
    const receive = await import("@/app/api/purchase-orders/[id]/receive/route");
    // Over-receipt is a 409.
    await api(receive.POST, `/api/purchase-orders/${po.id}/receive`, { json: { lines: [{ product_id: widget.id, qty: 11 }] }, params: { id: po.id }, expect: 409 });
    const r = await api<{ purchase_order: PO; recosted: Record<string, number> }>(receive.POST, `/api/purchase-orders/${po.id}/receive`, {
      json: { lines: [{ product_id: widget.id, qty: 10 }], note: "Box 1 of 2" },
      params: { id: po.id },
      expect: 200,
    });
    expect(r.body.purchase_order.status).toBe("partially_received");
    // 10 @ 100 on hand + 10 @ 200 received → 150
    expect(r.body.recosted[widget.id]).toBe(150);
    const prod = await import("@/app/api/products/[id]/route");
    const w = (await api<{ product: Product }>(prod.GET, `/api/products/${widget.id}`, { params: { id: widget.id }, expect: 200 })).body.product;
    expect(w.stock_on_hand).toBe(20);
    expect(w.cost_minor).toBe(150);
    expect(w.last_cost_minor).toBe(200);
    const mv = await sql<{ kind: string; qty: number }>(`SELECT kind, qty FROM stock_movements WHERE user_id = $1 AND product_id = $2 AND ref_kind = 'purchase_order' AND ref_id = $3`, [org.dataId, widget.id, po.id]);
    expect(mv).toEqual([{ kind: "receive", qty: 10 }]);
    await expectEvent(org.dataId, "purchase_order.received", po.id);
  });

  it("final receipt completes the order; a received order cannot be cancelled", async () => {
    const receive = await import("@/app/api/purchase-orders/[id]/receive/route");
    const r = await api<{ purchase_order: PO; recosted: Record<string, number> }>(receive.POST, `/api/purchase-orders/${po.id}/receive`, {
      json: { lines: [{ product_id: gadget.id, qty: 4 }] },
      params: { id: po.id },
      expect: 200,
    });
    expect(r.body.purchase_order.status).toBe("received");
    expect(r.body.recosted[gadget.id]).toBe(500); // nothing on hand → purchase cost
    const detail = await import("@/app/api/purchase-orders/[id]/route");
    const d = await api<{ progress: Array<{ product_id: string; ordered: number; received: number }>; receipts: unknown[] }>(detail.GET, `/api/purchase-orders/${po.id}`, { params: { id: po.id }, expect: 200 });
    expect(d.body.receipts).toHaveLength(2);
    expect(d.body.progress.every((p) => p.received === p.ordered)).toBe(true);
    const cancel = await import("@/app/api/purchase-orders/[id]/cancel/route");
    await api(cancel.POST, `/api/purchase-orders/${po.id}/cancel`, { method: "POST", params: { id: po.id }, expect: 400 });
  });

  it("bills the PO (idempotent), due date from supplier terms, BILL number, event", async () => {
    const bills = await import("@/app/api/supplier-bills/route");
    bill = (await api<{ bill: Bill }>(bills.POST, "/api/supplier-bills", { json: { from_purchase_order_id: po.id, supplier_ref: "ACME-889" }, expect: 201 })).body.bill;
    expect(bill.number).toMatch(/^BILL-\d{6}$/);
    expect(bill.status).toBe("open");
    expect(bill.total_minor).toBe(5700);
    expect(bill.purchase_order_id).toBe(po.id);
    const dueIn = (new Date(bill.due_at ?? 0).getTime() - Date.now()) / 86_400_000;
    expect(dueIn).toBeGreaterThan(13);
    expect(dueIn).toBeLessThan(15);
    const again = (await api<{ bill: Bill }>(bills.POST, "/api/supplier-bills", { json: { from_purchase_order_id: po.id }, expect: 201 })).body.bill;
    expect(again.id).toBe(bill.id);
    await expectEvent(org.dataId, "supplier_bill.created", bill.id);
    const pdf = await import("@/app/api/supplier-bills/[id]/pdf/route");
    const out = await call(pdf.GET, req(`/api/supplier-bills/${bill.id}/pdf`), { id: bill.id }, 200);
    expect(out.text).toContain("SUPPLIER BILL");
    expect(out.text).toContain("ACME-889");
  });

  it("records payments: partial → partially_paid with an expense row; rest → paid + event; overpay refused", async () => {
    const pay = await import("@/app/api/supplier-bills/[id]/payments/route");
    await api(pay.POST, `/api/supplier-bills/${bill.id}/payments`, { json: { amount_minor: 9999999 }, params: { id: bill.id }, expect: 400 });
    const p1 = await api<{ bill: Bill; payment: { id: string; expense_id: string | null } }>(pay.POST, `/api/supplier-bills/${bill.id}/payments`, {
      json: { amount_minor: 2000, method: "bank", ref: "TXN-1" },
      params: { id: bill.id },
      expect: 201,
    });
    expect(p1.body.bill.status).toBe("partially_paid");
    expect(p1.body.bill.paid_minor).toBe(2000);
    expect(p1.body.payment.expense_id).toBeTruthy();
    const exp = await sqlOne<{ category: string; amount_minor: string; ref_kind: string; ref_id: string; vendor: string }>(`SELECT category, amount_minor, ref_kind, ref_id, vendor FROM expenses WHERE id = $1 AND user_id = $2`, [p1.body.payment.expense_id, org.dataId]);
    expect(exp).toMatchObject({ category: "purchases", ref_kind: "bill", ref_id: bill.id, vendor: "Acme Parts" });
    expect(Number(exp?.amount_minor)).toBe(2000);

    const p2 = await api<{ bill: Bill }>(pay.POST, `/api/supplier-bills/${bill.id}/payments`, { json: { amount_minor: 3700 }, params: { id: bill.id }, expect: 201 });
    expect(p2.body.bill.status).toBe("paid");
    expect(p2.body.bill.outstanding_minor).toBe(0);
    await expectEvent(org.dataId, "supplier_bill.paid", bill.id);
    await api(pay.POST, `/api/supplier-bills/${bill.id}/payments`, { json: { amount_minor: 1 }, params: { id: bill.id }, expect: 400 });
    const list = await api<{ payments: unknown[] }>(pay.GET, `/api/supplier-bills/${bill.id}/payments`, { params: { id: bill.id }, expect: 200 });
    expect(list.body.payments).toHaveLength(2);
  });

  it("AP aging buckets an overdue open bill per supplier; overdue filter finds it", async () => {
    const bills = await import("@/app/api/supplier-bills/route");
    const overdue = (await api<{ bill: Bill }>(bills.POST, "/api/supplier-bills", {
      json: { supplier_id: supplier.id, items: [{ description: "Late one", qty: 1, unit_minor: 4000 }], issued_at: new Date(Date.now() - 60 * 86_400_000).toISOString(), due_at: new Date(Date.now() - 45 * 86_400_000).toISOString() },
      expect: 201,
    })).body.bill;
    expect(overdue.overdue).toBe(true);
    const aging = await import("@/app/api/reports/ap-aging/route");
    const a = await api<{ aging: Aging }>(aging.GET, "/api/reports/ap-aging", { expect: 200 });
    const row = a.body.aging.rows.find((r) => r.supplier_id === supplier.id);
    expect(row?.total_minor).toBe(4000);
    expect(row?.buckets.d31_60).toBe(4000);
    expect(a.body.aging.total_minor).toBe(4000);
    const filtered = await api<{ bills: Bill[] }>(bills.GET, "/api/supplier-bills", { query: { overdue: 1 }, expect: 200 });
    expect(filtered.body.bills.map((b) => b.id)).toEqual([overdue.id]);
  });

  it("reorder suggestions group by preferred supplier and 'Create POs' drafts one per supplier", async () => {
    // Consume widgets so they drop below the reorder point (20 on hand, reorder at 5).
    const stock = await import("@/app/api/products/[id]/stock/route");
    await api(stock.POST, `/api/products/${widget.id}/stock`, { json: { kind: "consume", qty: 17 }, params: { id: widget.id }, expect: 200 });
    const reorder = await import("@/app/api/inventory/reorder/route");
    const r = await api<{ suggestions: Array<{ product_id: string; suggested_qty: number; unit_cost_minor: number }>; groups: Array<{ supplier_id: string | null; lines: unknown[] }> }>(reorder.GET, "/api/inventory/reorder", { expect: 200 });
    const w = r.body.suggestions.find((s) => s.product_id === widget.id);
    expect(w).toBeTruthy();
    expect(w?.suggested_qty).toBe(7); // target 10, available 3
    expect(w?.unit_cost_minor).toBe(200); // last purchase cost
    expect(r.body.groups.find((g) => g.supplier_id === supplier.id)?.lines.length).toBeGreaterThan(0);
    const created = await api<{ purchase_orders: PO[]; skipped: unknown[] }>(reorder.POST, "/api/inventory/reorder", { json: {}, expect: 201 });
    expect(created.body.purchase_orders).toHaveLength(1);
    expect(created.body.purchase_orders[0].supplier_id).toBe(supplier.id);
    expect(created.body.purchase_orders[0].status).toBe("draft");
    expect(created.body.purchase_orders[0].items.some((it) => it.product_id === widget.id && it.qty === 7)).toBe(true);
  });

  it("viewer role cannot write; unauthenticated gets 401", async () => {
    const suppliers = await import("@/app/api/suppliers/route");
    setScope(org, { role: "viewer" });
    const r = await api(suppliers.POST, "/api/suppliers", { json: { name: "Nope" } });
    expect([401, 403]).toContain(r.status);
    setScope(null);
    await api(suppliers.GET, "/api/suppliers", { expect: 401 });
    setScope(org);
  });

  it("v1: 401 without a key, 403 with the wrong scope, 200 with read:billing", async () => {
    const v1 = await import("@/app/api/v1/purchase-orders/route");
    await api(v1.GET, "/api/v1/purchase-orders", { expect: 401 });
    const keys = await import("@/app/api/api-keys/route");
    const wrong = await api<{ key: string }>(keys.POST, "/api/api-keys", { json: { name: "Procurement wrong scope", scopes: ["read:crm"] }, expect: 201 });
    await api(v1.GET, "/api/v1/purchase-orders", { headers: { authorization: `Bearer ${wrong.body.key}` }, expect: 403 });
    const right = await api<{ key: string }>(keys.POST, "/api/api-keys", { json: { name: "Procurement billing", scopes: ["write:billing"] }, expect: 201 });
    apiKeyToken = right.body.key;
    const ok = await api<{ data: PO[] }>(v1.GET, "/api/v1/purchase-orders", { headers: { authorization: `Bearer ${apiKeyToken}` }, expect: 200 });
    expect(ok.body.data.map((p) => p.id)).toContain(po.id);
    const bills = await import("@/app/api/v1/supplier-bills/[id]/route");
    const b = await api<{ data: Bill }>(bills.GET, `/api/v1/supplier-bills/${bill.id}`, { headers: { authorization: `Bearer ${apiKeyToken}` }, params: { id: bill.id }, expect: 200 });
    expect(b.body.data.status).toBe("paid");
    const sup = await import("@/app/api/v1/suppliers/route");
    const s = await api<{ data: Supplier[] }>(sup.GET, "/api/v1/suppliers", { headers: { authorization: `Bearer ${apiKeyToken}` }, expect: 200 });
    expect(s.body.data.map((x) => x.id)).toContain(supplier.id);
  });
});
