import { createHash } from "crypto";
import type { AccountingExpense, AccountingInvoice, AccountingPayment, AccountingProduct, AccountingContact, AccountingSettings } from "./types";

/**
 * Pure payload builders for QuickBooks Online and Xero. No I/O, no DB — the
 * providers call these and tests assert on the JSON. Money arrives as minor
 * units and leaves as decimal strings/numbers in major units.
 */

const ZERO_DECIMAL = new Set(["JPY", "KRW", "VND", "CLP", "ISK", "UGX", "XAF", "XOF", "PYG", "RWF", "GNF", "KMF", "DJF", "BIF", "VUV", "XPF"]);
const THREE_DECIMAL = new Set(["BHD", "IQD", "JOD", "KWD", "LYD", "OMR", "TND"]);

export function currencyDecimals(currency: string): number {
  const c = currency.toUpperCase();
  if (ZERO_DECIMAL.has(c)) return 0;
  if (THREE_DECIMAL.has(c)) return 3;
  return 2;
}

/** 1999 (USD) → 19.99; 1999 (JPY) → 1999. */
export function minorToMajor(minor: number, currency: string): number {
  const d = currencyDecimals(currency);
  return Number((minor / 10 ** d).toFixed(d));
}

/** 19.99 (USD) → 1999, rounded half-up. */
export function majorToMinor(major: number | string, currency: string): number {
  const d = currencyDecimals(currency);
  return Math.round(Number(major) * 10 ** d);
}

export function dateOnly(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

/** Stable hash of a payload: keys sorted recursively so property order never causes a re-push. */
export function payloadHash(payload: unknown): string {
  return createHash("sha256").update(canonical(payload)).digest("hex");
}

export function canonical(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o).filter((k) => o[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(",")}}`;
}

const VOLATILE = new Set(["Id", "SyncToken", "sparse", "InvoiceID", "ContactID", "PaymentID", "BankTransactionID", "ItemID", "UpdatedDateUTC", "MetaData"]);
/** Strip optimistic-locking / server-assigned fields so hashes compare content, not versions. */
export function stripVolatile(p: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(p).filter(([k]) => !VOLATILE.has(k)));
}

// ── QuickBooks Online ────────────────────────────────────────────────────────

export type QboPayload = Record<string, unknown>;

export function qboCustomer(c: AccountingContact): QboPayload {
  const p: QboPayload = { DisplayName: c.full_name.slice(0, 500) };
  if (c.company) p.CompanyName = c.company.slice(0, 100);
  if (c.email) p.PrimaryEmailAddr = { Address: c.email };
  if (c.phone) p.PrimaryPhone = { FreeFormNumber: c.phone.slice(0, 30) };
  return p;
}

export function qboInvoice(inv: AccountingInvoice, s: AccountingSettings): QboPayload {
  if (!inv.contact_remote_id) throw new Error("Invoice needs a customer before it can be pushed to QuickBooks");
  const cur = inv.currency;
  const lines = inv.items.map((it, idx) => {
    const amount = minorToMajor(Math.round(it.qty * it.unit_minor), cur);
    const detail: QboPayload = {
      Qty: it.qty,
      UnitPrice: minorToMajor(it.unit_minor, cur),
      TaxCodeRef: { value: it.tax_rate_bp > 0 ? (s.tax_code_id ?? "TAX") : (s.zero_tax_code_id ?? "NON") },
    };
    if (it.item_remote_id) detail.ItemRef = { value: it.item_remote_id };
    else if (s.sales_account_id) detail.ItemAccountRef = { value: s.sales_account_id };
    return { LineNum: idx + 1, Description: it.description.slice(0, 4000), Amount: amount, DetailType: "SalesItemLineDetail", SalesItemLineDetail: detail };
  });
  const p: QboPayload = {
    DocNumber: inv.number.slice(0, 21),
    CustomerRef: { value: inv.contact_remote_id },
    TxnDate: dateOnly(inv.created_at),
    CurrencyRef: { value: cur },
    Line: lines,
    PrivateNote: `KernelHub invoice ${inv.id}`,
  };
  if (inv.due_at) p.DueDate = dateOnly(inv.due_at);
  if (inv.notes) p.CustomerMemo = { value: inv.notes.slice(0, 1000) };
  if (inv.tax_minor > 0) p.TxnTaxDetail = { TotalTax: minorToMajor(inv.tax_minor, cur) };
  return p;
}

export function qboPayment(pay: AccountingPayment, s: AccountingSettings): QboPayload {
  if (!pay.contact_remote_id) throw new Error("Payment needs the invoice's customer before it can be pushed to QuickBooks");
  const amount = minorToMajor(pay.amount_minor, pay.currency);
  const p: QboPayload = {
    CustomerRef: { value: pay.contact_remote_id },
    TotalAmt: amount,
    TxnDate: dateOnly(pay.created_at),
    CurrencyRef: { value: pay.currency },
    PaymentRefNum: (pay.provider_ref ?? pay.id).slice(0, 21),
    PrivateNote: `KernelHub payment ${pay.id} via ${pay.provider}`,
    Line: [{ Amount: amount, LinkedTxn: [{ TxnId: pay.invoice_remote_id, TxnType: "Invoice" }] }],
  };
  if (s.deposit_account_id) p.DepositToAccountRef = { value: s.deposit_account_id };
  return p;
}

export function qboPurchase(e: AccountingExpense, s: AccountingSettings): QboPayload {
  if (!s.expense_account_id) throw new Error("Choose an expense account in Accounting settings before pushing expenses");
  if (!s.deposit_account_id) throw new Error("Choose a bank account in Accounting settings before pushing expenses");
  const cur = e.currency;
  const desc = [e.vendor, e.description].filter(Boolean).join(" — ") || e.category;
  const line: QboPayload = {
    Amount: minorToMajor(e.amount_minor + e.tax_minor, cur),
    DetailType: "AccountBasedExpenseLineDetail",
    Description: desc.slice(0, 4000),
    AccountBasedExpenseLineDetail: {
      AccountRef: { value: s.expense_account_id },
      TaxCodeRef: { value: e.tax_minor > 0 ? (s.tax_code_id ?? "TAX") : (s.zero_tax_code_id ?? "NON") },
    },
  };
  return {
    PaymentType: "Cash",
    AccountRef: { value: s.deposit_account_id },
    TxnDate: dateOnly(e.spent_at),
    CurrencyRef: { value: cur },
    PrivateNote: `KernelHub expense ${e.id} (${e.category})`,
    Line: [line],
  };
}

export function qboItem(p: AccountingProduct, s: AccountingSettings): QboPayload {
  const out: QboPayload = {
    Name: (p.sku ? `${p.name} (${p.sku})` : p.name).slice(0, 100),
    Type: p.kind === "service" ? "Service" : "NonInventory",
    UnitPrice: minorToMajor(p.unit_price_minor, p.currency),
    Taxable: p.tax_rate_bp > 0,
  };
  if (p.description) out.Description = p.description.slice(0, 4000);
  if (p.sku) out.Sku = p.sku.slice(0, 100);
  if (s.sales_account_id) out.IncomeAccountRef = { value: s.sales_account_id };
  if (p.cost_minor > 0 && s.expense_account_id) {
    out.PurchaseCost = minorToMajor(p.cost_minor, p.currency);
    out.ExpenseAccountRef = { value: s.expense_account_id };
  }
  return out;
}

// ── Xero ─────────────────────────────────────────────────────────────────────

export type XeroPayload = Record<string, unknown>;

export function xeroContact(c: AccountingContact): XeroPayload {
  const p: XeroPayload = { Name: c.full_name.slice(0, 255) };
  if (c.email) p.EmailAddress = c.email;
  if (c.phone) p.Phones = [{ PhoneType: "DEFAULT", PhoneNumber: c.phone.slice(0, 50) }];
  return p;
}

function xeroTaxType(rateBp: number, s: AccountingSettings): string {
  return rateBp > 0 ? (s.tax_code_id ?? "OUTPUT") : (s.zero_tax_code_id ?? "NONE");
}

export function xeroInvoice(inv: AccountingInvoice, s: AccountingSettings): XeroPayload {
  if (!inv.contact_remote_id) throw new Error("Invoice needs a contact before it can be pushed to Xero");
  const cur = inv.currency;
  const p: XeroPayload = {
    Type: "ACCREC",
    Contact: { ContactID: inv.contact_remote_id },
    InvoiceNumber: inv.number.slice(0, 255),
    Reference: `KernelHub ${inv.id}`,
    Date: dateOnly(inv.created_at),
    CurrencyCode: cur,
    LineAmountTypes: "Exclusive",
    Status: inv.status === "draft" ? "DRAFT" : "AUTHORISED",
    LineItems: inv.items.map((it) => {
      const li: XeroPayload = {
        Description: it.description.slice(0, 4000),
        Quantity: it.qty,
        UnitAmount: minorToMajor(it.unit_minor, cur),
        TaxType: xeroTaxType(it.tax_rate_bp, s),
        LineAmount: minorToMajor(Math.round(it.qty * it.unit_minor), cur),
      };
      if (it.item_remote_id) li.ItemCode = it.item_remote_id;
      if (s.sales_account_id) li.AccountCode = s.sales_account_id;
      return li;
    }),
  };
  if (inv.due_at) p.DueDate = dateOnly(inv.due_at);
  return p;
}

export function xeroPayment(pay: AccountingPayment, s: AccountingSettings): XeroPayload {
  if (!s.deposit_account_id) throw new Error("Choose a bank account in Accounting settings before pushing payments to Xero");
  return {
    Invoice: { InvoiceID: pay.invoice_remote_id },
    Account: { AccountID: s.deposit_account_id },
    Date: dateOnly(pay.created_at),
    Amount: minorToMajor(pay.amount_minor, pay.currency),
    Reference: (pay.provider_ref ?? pay.id).slice(0, 255),
  };
}

export function xeroBankTransaction(e: AccountingExpense, s: AccountingSettings): XeroPayload {
  if (!s.expense_account_id) throw new Error("Choose an expense account in Accounting settings before pushing expenses");
  if (!s.deposit_account_id) throw new Error("Choose a bank account in Accounting settings before pushing expenses");
  const cur = e.currency;
  const desc = [e.vendor, e.description].filter(Boolean).join(" — ") || e.category;
  return {
    Type: "SPEND",
    Contact: { Name: (e.vendor ?? "Supplier").slice(0, 255) },
    BankAccount: { AccountID: s.deposit_account_id },
    Date: dateOnly(e.spent_at),
    CurrencyCode: cur,
    Reference: `KernelHub expense ${e.id}`,
    LineAmountTypes: "Exclusive",
    LineItems: [
      {
        Description: desc.slice(0, 4000),
        Quantity: 1,
        UnitAmount: minorToMajor(e.amount_minor, cur),
        AccountCode: s.expense_account_id,
        TaxType: e.tax_minor > 0 ? (s.tax_code_id ?? "INPUT") : (s.zero_tax_code_id ?? "NONE"),
        TaxAmount: minorToMajor(e.tax_minor, cur),
      },
    ],
  };
}

export function xeroItem(p: AccountingProduct, s: AccountingSettings): XeroPayload {
  const out: XeroPayload = {
    Code: (p.sku ?? `KH-${p.id.slice(0, 8)}`).slice(0, 30),
    Name: p.name.slice(0, 50),
    IsSold: true,
    IsPurchased: p.cost_minor > 0,
    SalesDetails: { UnitPrice: minorToMajor(p.unit_price_minor, p.currency), ...(s.sales_account_id ? { AccountCode: s.sales_account_id } : {}), TaxType: xeroTaxType(p.tax_rate_bp, s) },
  };
  if (p.description) out.Description = p.description.slice(0, 4000);
  if (p.cost_minor > 0) out.PurchaseDetails = { UnitPrice: minorToMajor(p.cost_minor, p.currency), ...(s.expense_account_id ? { AccountCode: s.expense_account_id } : {}) };
  return out;
}

// ── Pull de-dup ──────────────────────────────────────────────────────────────

/**
 * Decide which remote payments must be recorded locally. A remote payment is
 * skipped when we pushed it ourselves (its remote id is a payment link) or when
 * a local payment with the same provider ref already exists.
 */
export function selectNewRemotePayments<T extends { remoteId: string; remoteInvoiceId: string }>(
  remote: readonly T[],
  pushedRemoteIds: ReadonlySet<string>,
  existingProviderRefs: ReadonlySet<string>,
  invoiceByRemoteId: ReadonlyMap<string, string>
): Array<T & { invoiceId: string }> {
  const out: Array<T & { invoiceId: string }> = [];
  const seen = new Set<string>();
  for (const r of remote) {
    if (seen.has(r.remoteId)) continue;
    seen.add(r.remoteId);
    if (pushedRemoteIds.has(r.remoteId) || existingProviderRefs.has(r.remoteId)) continue;
    const invoiceId = invoiceByRemoteId.get(r.remoteInvoiceId);
    if (!invoiceId) continue;
    out.push({ ...r, invoiceId });
  }
  return out;
}

/** Provider string recorded on invoice_payments for pulled payments. */
export function pulledPaymentProvider(providerId: string): string {
  return `accounting:${providerId}`;
}
