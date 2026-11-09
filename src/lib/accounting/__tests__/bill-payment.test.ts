import { describe, expect, it } from "vitest";
import { qboBillPayment, xeroBillPayment } from "@/lib/accounting/mapping";
import { entityKindForEvent } from "@/lib/accounting/sync";
import { ACCOUNTING_ENTITY_KINDS, type AccountingBillPayment, type AccountingSettings } from "@/lib/accounting/types";

const settings: AccountingSettings = { expense_account_id: "64", deposit_account_id: "35" };
const payment: AccountingBillPayment = {
  id: "bp-1", bill_id: "bill-1", amount_minor: 12_050, currency: "USD", method: "bank", ref: "TRX-77", paid_at: "2026-03-03T09:30:00.000Z",
  bill_remote_id: "QBO-BILL-9", supplier_remote_id: "VEND-4",
};

describe("supplier bill payments → accounting", () => {
  it("builds a QuickBooks BillPayment linked to the Bill from the bank account", () => {
    const p = qboBillPayment(payment, settings) as Record<string, unknown>;
    expect(p).toMatchObject({ VendorRef: { value: "VEND-4" }, PayType: "Check", CheckPayment: { BankAccountRef: { value: "35" } }, TotalAmt: 120.5, TxnDate: "2026-03-03", DocNumber: "TRX-77" });
    expect(p.Line).toEqual([{ Amount: 120.5, LinkedTxn: [{ TxnId: "QBO-BILL-9", TxnType: "Bill" }] }]);
    expect(() => qboBillPayment({ ...payment, supplier_remote_id: null }, settings)).toThrow(/vendor/);
    expect(() => qboBillPayment(payment, { ...settings, deposit_account_id: null })).toThrow(/bank account/);
  });

  it("builds a Xero Payment against the ACCPAY invoice", () => {
    expect(xeroBillPayment(payment, settings)).toEqual({ Invoice: { InvoiceID: "QBO-BILL-9" }, Account: { AccountID: "35" }, Date: "2026-03-03", Amount: 120.5, Reference: "TRX-77" });
    expect(() => xeroBillPayment(payment, {})).toThrow(/bank account/);
  });

  it("registers the entity kind and routes supplier_bill.paid / product.created events", () => {
    expect(ACCOUNTING_ENTITY_KINDS).toContain("bill_payment");
    expect(entityKindForEvent("supplier_bill.paid")).toBe("bill");
    expect(entityKindForEvent("supplier_bill.created")).toBe("bill");
    expect(entityKindForEvent("product.created")).toBe("product");
    expect(entityKindForEvent("invoice.sent")).toBe("invoice");
    expect(entityKindForEvent("task.created")).toBeNull();
  });
});
