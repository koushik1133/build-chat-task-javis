import { describe, expect, it } from "vitest";
import {
  canonical, currencyDecimals, majorToMinor, minorToMajor, payloadHash, pulledPaymentProvider, qboCustomer, qboInvoice, qboPayment, qboPurchase, qboItem,
  selectNewRemotePayments, stripVolatile, xeroBankTransaction, xeroInvoice, xeroItem, xeroPayment,
} from "@/lib/accounting/mapping";
import type { AccountingExpense, AccountingInvoice, AccountingPayment, AccountingProduct, AccountingSettings } from "@/lib/accounting/types";

const settings: AccountingSettings = { sales_account_id: "79", expense_account_id: "64", deposit_account_id: "35", tax_code_id: "TAX", zero_tax_code_id: "NON" };

const invoice: AccountingInvoice = {
  id: "inv-1", number: "INV-0007", status: "sent", currency: "USD", subtotal_minor: 12_500, tax_minor: 1_000, total_minor: 13_500,
  due_at: "2026-02-01T00:00:00.000Z", created_at: "2026-01-15T10:00:00.000Z", notes: "Thanks!",
  items: [
    { description: "Design work", qty: 2, unit_minor: 5_000, tax_rate_bp: 1000 },
    { description: "Widget", qty: 1, unit_minor: 2_500, tax_rate_bp: 0, product_id: "p1", item_remote_id: "ITEM-9" },
  ],
  contact_remote_id: "CUST-42",
};

describe("money conversion", () => {
  it("handles 2-, 0- and 3-decimal currencies", () => {
    expect(currencyDecimals("USD")).toBe(2);
    expect(minorToMajor(1999, "USD")).toBe(19.99);
    expect(minorToMajor(1999, "JPY")).toBe(1999);
    expect(minorToMajor(12345, "KWD")).toBe(12.345);
    expect(majorToMinor(19.99, "USD")).toBe(1999);
    expect(majorToMinor("0.1", "USD")).toBe(10);
    expect(majorToMinor(1999, "JPY")).toBe(1999);
  });
});

describe("QuickBooks payloads", () => {
  it("builds an Invoice with per-line tax codes, item refs and major-unit decimals", () => {
    const p = qboInvoice(invoice, settings);
    expect(p.DocNumber).toBe("INV-0007");
    expect(p.CustomerRef).toEqual({ value: "CUST-42" });
    expect(p.TxnDate).toBe("2026-01-15");
    expect(p.DueDate).toBe("2026-02-01");
    expect(p.CurrencyRef).toEqual({ value: "USD" });
    expect(p.TxnTaxDetail).toEqual({ TotalTax: 10 });
    const lines = p.Line as Array<Record<string, unknown>>;
    expect(lines).toHaveLength(2);
    expect(lines[0].Amount).toBe(100);
    expect(lines[0].DetailType).toBe("SalesItemLineDetail");
    const d0 = lines[0].SalesItemLineDetail as Record<string, unknown>;
    expect(d0.Qty).toBe(2);
    expect(d0.UnitPrice).toBe(50);
    expect(d0.TaxCodeRef).toEqual({ value: "TAX" });
    expect(d0.ItemAccountRef).toEqual({ value: "79" });
    const d1 = lines[1].SalesItemLineDetail as Record<string, unknown>;
    expect(d1.TaxCodeRef).toEqual({ value: "NON" });
    expect(d1.ItemRef).toEqual({ value: "ITEM-9" });
    expect(d1.ItemAccountRef).toBeUndefined();
  });
  it("refuses an invoice without a customer", () => {
    expect(() => qboInvoice({ ...invoice, contact_remote_id: null }, settings)).toThrow(/customer/);
  });
  it("links a Payment to the invoice and deposit account", () => {
    const pay: AccountingPayment = { id: "pay-1", invoice_id: "inv-1", amount_minor: 13_500, currency: "USD", provider: "stripe", provider_ref: "pi_123", created_at: "2026-01-20T00:00:00Z", invoice_remote_id: "QBO-INV-1", contact_remote_id: "CUST-42" };
    const p = qboPayment(pay, settings);
    expect(p.TotalAmt).toBe(135);
    expect(p.PaymentRefNum).toBe("pi_123");
    expect(p.DepositToAccountRef).toEqual({ value: "35" });
    expect(p.Line).toEqual([{ Amount: 135, LinkedTxn: [{ TxnId: "QBO-INV-1", TxnType: "Invoice" }] }]);
  });
  it("books an expense as a Purchase and requires the mapped accounts", () => {
    const e: AccountingExpense = { id: "e1", category: "fuel", vendor: "Shell", description: "Van", amount_minor: 4_000, tax_minor: 800, currency: "GBP", spent_at: "2026-01-03T12:00:00Z" };
    const p = qboPurchase(e, settings);
    expect(p.PaymentType).toBe("Cash");
    expect(p.AccountRef).toEqual({ value: "35" });
    const line = (p.Line as Array<Record<string, unknown>>)[0];
    expect(line.Amount).toBe(48);
    expect((line.AccountBasedExpenseLineDetail as Record<string, unknown>).AccountRef).toEqual({ value: "64" });
    expect(() => qboPurchase(e, {})).toThrow(/expense account/);
  });
  it("maps products to Items and contacts to Customers", () => {
    const prod: AccountingProduct = { id: "p1", sku: "W-1", name: "Widget", description: null, kind: "product", unit_price_minor: 2_500, cost_minor: 1_000, currency: "USD", tax_rate_bp: 0, track_stock: true };
    const it = qboItem(prod, settings);
    expect(it.Type).toBe("NonInventory");
    expect(it.UnitPrice).toBe(25);
    expect(it.PurchaseCost).toBe(10);
    expect(it.Taxable).toBe(false);
    expect(qboItem({ ...prod, kind: "service" }, settings).Type).toBe("Service");
    const c = qboCustomer({ id: "c1", full_name: "Ada Lovelace", email: "ada@example.com", phone: "+44 1", company: "Analytical" });
    expect(c.DisplayName).toBe("Ada Lovelace");
    expect(c.PrimaryEmailAddr).toEqual({ Address: "ada@example.com" });
  });
});

describe("Xero payloads", () => {
  it("builds an ACCREC invoice with exclusive line amounts", () => {
    const p = xeroInvoice(invoice, settings);
    expect(p.Type).toBe("ACCREC");
    expect(p.Status).toBe("AUTHORISED");
    expect(p.Contact).toEqual({ ContactID: "CUST-42" });
    expect(p.LineAmountTypes).toBe("Exclusive");
    const li = p.LineItems as Array<Record<string, unknown>>;
    expect(li[0]).toMatchObject({ Quantity: 2, UnitAmount: 50, LineAmount: 100, TaxType: "TAX", AccountCode: "79" });
    expect(li[1]).toMatchObject({ TaxType: "NON", ItemCode: "ITEM-9" });
    expect(xeroInvoice({ ...invoice, status: "draft" }, settings).Status).toBe("DRAFT");
  });
  it("maps payments, spend transactions and items", () => {
    const pay: AccountingPayment = { id: "pay-1", invoice_id: "inv-1", amount_minor: 1_000, currency: "EUR", provider: "manual", provider_ref: null, created_at: "2026-01-20T00:00:00Z", invoice_remote_id: "X-INV", contact_remote_id: null };
    expect(xeroPayment(pay, settings)).toMatchObject({ Invoice: { InvoiceID: "X-INV" }, Account: { AccountID: "35" }, Amount: 10, Reference: "pay-1" });
    expect(() => xeroPayment(pay, {})).toThrow(/bank account/);
    const e: AccountingExpense = { id: "e1", category: "meals", vendor: null, description: "Lunch", amount_minor: 2_000, tax_minor: 0, currency: "EUR", spent_at: "2026-01-03T12:00:00Z" };
    const bt = xeroBankTransaction(e, settings);
    expect(bt.Type).toBe("SPEND");
    expect((bt.LineItems as Array<Record<string, unknown>>)[0]).toMatchObject({ UnitAmount: 20, AccountCode: "64", TaxType: "NON", TaxAmount: 0 });
    const item = xeroItem({ id: "p1", sku: null, name: "Consulting", description: null, kind: "service", unit_price_minor: 15_000, cost_minor: 0, currency: "EUR", tax_rate_bp: 2000, track_stock: false }, settings);
    expect(String(item.Code)).toMatch(/^KH-/);
    expect(item.SalesDetails).toMatchObject({ UnitPrice: 150, TaxType: "TAX" });
    expect(item.IsPurchased).toBe(false);
  });
});

describe("hash / skip", () => {
  it("is independent of key order and ignores volatile fields", () => {
    const a = { Line: [{ Amount: 1, X: "y" }], DocNumber: "1", Id: "9", SyncToken: "3" };
    const b = { SyncToken: "4", Id: "10", DocNumber: "1", Line: [{ X: "y", Amount: 1 }] };
    expect(canonical({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(payloadHash(stripVolatile(a))).toBe(payloadHash(stripVolatile(b)));
    expect(payloadHash(stripVolatile({ ...a, DocNumber: "2" }))).not.toBe(payloadHash(stripVolatile(b)));
    expect(canonical({ a: undefined, b: null })).toBe('{"b":null}');
  });
});

describe("pull de-dup", () => {
  it("skips payments we pushed, payments already recorded, and unknown invoices", () => {
    const remote = [
      { remoteId: "R1", remoteInvoiceId: "QI-1" },
      { remoteId: "R2", remoteInvoiceId: "QI-1" }, // we pushed this one
      { remoteId: "R3", remoteInvoiceId: "QI-1" }, // already recorded locally
      { remoteId: "R4", remoteInvoiceId: "QI-unknown" },
      { remoteId: "R1", remoteInvoiceId: "QI-1" }, // duplicate in the same batch
    ];
    const out = selectNewRemotePayments(remote, new Set(["R2"]), new Set(["R3"]), new Map([["QI-1", "inv-1"]]));
    expect(out).toEqual([{ remoteId: "R1", remoteInvoiceId: "QI-1", invoiceId: "inv-1" }]);
    expect(pulledPaymentProvider("xero")).toBe("accounting:xero");
  });
});
