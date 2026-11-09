import { describe, expect, it } from "vitest";
import { computeTotals } from "@/lib/money/tax";
import {
  agingBucket,
  buildAging,
  deriveBillStatus,
  groupBySupplier,
  isBillOverdue,
  orderedByProduct,
  overReceipts,
  receiptProgress,
  receiveStatus,
  receivedByProduct,
  suggestReorderQty,
  weightedAverageCost,
  type ReorderSuggestion,
} from "@/lib/procurement/pure";
import { qboBill, xeroBill } from "@/lib/accounting/mapping";

const DAY = 86_400_000;

describe("purchase order totals (tax engine)", () => {
  it("sums cost lines with inline and catalogue rates", () => {
    const rates = [{ id: "vat", name: "VAT", rate_bp: 2000, compound: false }];
    const t = computeTotals(
      [
        { qty: 10, unit_minor: 250, tax_rate_id: "vat" }, // 2500 + 500
        { qty: 3, unit_minor: 1000, tax_rate_bp: 500 }, // 3000 + 150
        { qty: 1, unit_minor: 99 }, // 99
      ],
      rates
    );
    expect(t.subtotal_minor).toBe(5599);
    expect(t.tax_minor).toBe(650);
    expect(t.total_minor).toBe(6249);
  });
});

describe("receiving status math", () => {
  const items = [
    { product_id: "a", qty: 10 },
    { product_id: "b", qty: 4 },
    { product_id: "a", qty: 2 }, // same product twice → 12
    { product_id: undefined, qty: 5 }, // unlinked line: not receivable
  ];
  const ordered = orderedByProduct(items);

  it("collapses ordered qty per product and ignores unlinked lines", () => {
    expect([...ordered.entries()]).toEqual([["a", 12], ["b", 4]]);
  });

  it("is null before anything arrives, partial after some, received when all lines are complete", () => {
    expect(receiveStatus(receiptProgress(ordered, receivedByProduct([])))).toBeNull();
    const partial = receivedByProduct([[{ product_id: "a", qty: 5 }]]);
    expect(receiveStatus(receiptProgress(ordered, partial))).toBe("partially_received");
    const almost = receivedByProduct([[{ product_id: "a", qty: 12 }], [{ product_id: "b", qty: 3 }]]);
    expect(receiveStatus(receiptProgress(ordered, almost))).toBe("partially_received");
    const full = receivedByProduct([[{ product_id: "a", qty: 12 }], [{ product_id: "b", qty: 4 }]]);
    expect(receiveStatus(receiptProgress(ordered, full))).toBe("received");
  });

  it("caps received at ordered in progress and flags over-receipts", () => {
    const received = receivedByProduct([[{ product_id: "a", qty: 10 }]]);
    expect(receiptProgress(ordered, received)).toEqual([{ product_id: "a", ordered: 12, received: 10 }, { product_id: "b", ordered: 4, received: 0 }]);
    expect(overReceipts([{ product_id: "a", qty: 2 }, { product_id: "b", qty: 4 }], ordered, received)).toEqual([]);
    expect(overReceipts([{ product_id: "a", qty: 3 }], ordered, received)).toEqual([{ product_id: "a", requested: 3, remaining: 2 }]);
    expect(overReceipts([{ product_id: "a", qty: 1 }, { product_id: "a", qty: 2 }], ordered, received)).toEqual([{ product_id: "a", requested: 3, remaining: 2 }]);
  });

  it("no receivable lines → null status", () => {
    expect(receiveStatus([])).toBeNull();
  });
});

describe("weighted average cost", () => {
  it("blends existing stock with the receipt, rounded half-up", () => {
    // 10 on hand @ 100, receive 10 @ 200 → 150
    expect(weightedAverageCost(10, 100, 10, 200)).toBe(150);
    // 3 @ 100 + 1 @ 150 → 112.5 → 113
    expect(weightedAverageCost(3, 100, 1, 150)).toBe(113);
  });
  it("takes the purchase cost when nothing was on hand or the old cost is zero", () => {
    expect(weightedAverageCost(0, 999, 5, 120)).toBe(120);
    expect(weightedAverageCost(-4, 50, 5, 120)).toBe(120);
    expect(weightedAverageCost(20, 0, 5, 120)).toBe(120);
  });
  it("keeps the old cost for a zero-qty receipt", () => {
    expect(weightedAverageCost(10, 100, 0, 500)).toBe(100);
  });
});

describe("AP aging", () => {
  const now = Date.parse("2026-11-09T12:00:00Z");
  it("buckets by days overdue", () => {
    expect(agingBucket(null, now)).toBe("current");
    expect(agingBucket(new Date(now + 5 * DAY).toISOString(), now)).toBe("current");
    expect(agingBucket(new Date(now).toISOString(), now)).toBe("current");
    expect(agingBucket(new Date(now - 1 * DAY).toISOString(), now)).toBe("d1_30");
    expect(agingBucket(new Date(now - 30 * DAY).toISOString(), now)).toBe("d1_30");
    expect(agingBucket(new Date(now - 31 * DAY).toISOString(), now)).toBe("d31_60");
    expect(agingBucket(new Date(now - 60 * DAY).toISOString(), now)).toBe("d31_60");
    expect(agingBucket(new Date(now - 61 * DAY).toISOString(), now)).toBe("d61_90");
    expect(agingBucket(new Date(now - 90 * DAY).toISOString(), now)).toBe("d61_90");
    expect(agingBucket(new Date(now - 91 * DAY).toISOString(), now)).toBe("d90_plus");
    expect(agingBucket("not-a-date", now)).toBe("current");
  });

  it("groups outstanding per supplier and currency, skipping settled bills", () => {
    const a = buildAging(
      [
        { supplier_id: "s1", supplier_name: "Acme", currency: "USD", total_minor: 10000, paid_minor: 2500, due_at: new Date(now - 10 * DAY).toISOString() },
        { supplier_id: "s1", supplier_name: "Acme", currency: "USD", total_minor: 5000, paid_minor: 0, due_at: new Date(now + 3 * DAY).toISOString() },
        { supplier_id: "s1", supplier_name: "Acme", currency: "EUR", total_minor: 800, paid_minor: 0, due_at: new Date(now - 100 * DAY).toISOString() },
        { supplier_id: "s2", supplier_name: "Bolt", currency: "USD", total_minor: 300, paid_minor: 300, due_at: null },
        { supplier_id: "s3", supplier_name: "Zed", currency: "USD", total_minor: 20000, paid_minor: 0, due_at: new Date(now - 45 * DAY).toISOString() },
      ],
      now
    );
    expect(a.rows.map((r) => [r.supplier_name, r.currency, r.total_minor, r.bills])).toEqual([["Zed", "USD", 20000, 1], ["Acme", "USD", 12500, 2], ["Acme", "EUR", 800, 1]]);
    expect(a.rows[1].buckets).toEqual({ current: 5000, d1_30: 7500, d31_60: 0, d61_90: 0, d90_plus: 0 });
    expect(a.totals).toEqual({ current: 5000, d1_30: 7500, d31_60: 20000, d61_90: 0, d90_plus: 800 });
    expect(a.total_minor).toBe(33300);
  });
});

describe("bill payment transitions", () => {
  it("open → partially_paid → paid; draft/void untouched", () => {
    expect(deriveBillStatus({ status: "open", total_minor: 1000, paid_minor: 0 })).toBe("open");
    expect(deriveBillStatus({ status: "open", total_minor: 1000, paid_minor: 400 })).toBe("partially_paid");
    expect(deriveBillStatus({ status: "partially_paid", total_minor: 1000, paid_minor: 1000 })).toBe("paid");
    expect(deriveBillStatus({ status: "draft", total_minor: 1000, paid_minor: 1000 })).toBe("draft");
    expect(deriveBillStatus({ status: "void", total_minor: 1000, paid_minor: 0 })).toBe("void");
  });
  it("overdue only applies to open/partially paid bills past due", () => {
    const now = Date.now();
    expect(isBillOverdue({ status: "open", due_at: new Date(now - DAY).toISOString() }, now)).toBe(true);
    expect(isBillOverdue({ status: "partially_paid", due_at: new Date(now - DAY).toISOString() }, now)).toBe(true);
    expect(isBillOverdue({ status: "open", due_at: new Date(now + DAY).toISOString() }, now)).toBe(false);
    expect(isBillOverdue({ status: "paid", due_at: new Date(now - DAY).toISOString() }, now)).toBe(false);
    expect(isBillOverdue({ status: "open", due_at: null }, now)).toBe(false);
  });
});

describe("reorder suggestions", () => {
  it("orders back up to twice the reorder point, never less than one", () => {
    expect(suggestReorderQty({ stock_on_hand: 2, stock_reserved: 0, reorder_point: 5 })).toBe(8);
    expect(suggestReorderQty({ stock_on_hand: 5, stock_reserved: 3, reorder_point: 2 })).toBe(2);
    expect(suggestReorderQty({ stock_on_hand: 0, stock_reserved: 0, reorder_point: 0 })).toBe(1);
    expect(suggestReorderQty({ stock_on_hand: 10, stock_reserved: 0, reorder_point: 10 })).toBe(10);
  });

  it("groups by preferred supplier + currency, unassigned last", () => {
    const mk = (id: string, sup: string | null, name: string | null, cur = "USD", qty = 2, cost = 100): ReorderSuggestion => ({
      product_id: id, name: id, sku: null, stock_available: 0, reorder_point: 1, suggested_qty: qty, unit_cost_minor: cost, currency: cur, preferred_supplier_id: sup, supplier_name: name,
    });
    const groups = groupBySupplier([mk("p1", null, null), mk("p2", "s2", "Zeta"), mk("p3", "s1", "Alpha"), mk("p4", "s1", "Alpha", "EUR"), mk("p5", "s1", "Alpha", "USD", 3, 50)]);
    expect(groups.map((g) => [g.supplier_name, g.currency, g.lines.map((l) => l.product_id), g.total_minor])).toEqual([
      ["Alpha", "USD", ["p3", "p5"], 350],
      ["Alpha", "EUR", ["p4"], 200],
      ["Zeta", "USD", ["p2"], 200],
      [null, "USD", ["p1"], 200],
    ]);
  });
});

describe("accounting bill payloads", () => {
  const bill = {
    id: "b1", number: "BILL-000001", supplier_ref: "INV-77", status: "open", currency: "USD", subtotal_minor: 2500, tax_minor: 500, total_minor: 3000,
    issued_at: "2026-11-01T00:00:00.000Z", due_at: "2026-12-01T00:00:00.000Z", notes: null, supplier_remote_id: "V1", supplier_name: "Acme",
    items: [{ description: "Widgets", qty: 10, unit_minor: 250, tax_rate_bp: 2000, product_id: "p1", item_remote_id: "I9" }],
  };
  it("QBO Bill uses the vendor, item lines when linked and the supplier reference as DocNumber", () => {
    const p = qboBill(bill, { expense_account_id: "60", tax_code_id: "TAX" });
    expect(p.VendorRef).toEqual({ value: "V1" });
    expect(p.DocNumber).toBe("INV-77");
    expect(p.DueDate).toBe("2026-12-01");
    const line = (p.Line as Array<Record<string, unknown>>)[0];
    expect(line.DetailType).toBe("ItemBasedExpenseLineDetail");
    expect(line.Amount).toBe(25);
    expect(() => qboBill({ ...bill, supplier_remote_id: null }, { expense_account_id: "60" })).toThrow(/vendor/i);
    expect(() => qboBill(bill, {})).toThrow(/expense account/i);
  });
  it("Xero bill is an ACCPAY invoice against the supplier contact", () => {
    const p = xeroBill(bill, { expense_account_id: "400", tax_code_id: "INPUT2" });
    expect(p.Type).toBe("ACCPAY");
    expect(p.Contact).toEqual({ ContactID: "V1" });
    expect(p.Status).toBe("AUTHORISED");
    const li = (p.LineItems as Array<Record<string, unknown>>)[0];
    expect(li.AccountCode).toBe("400");
    expect(li.TaxType).toBe("INPUT2");
    expect(li.ItemCode).toBe("I9");
  });
});
