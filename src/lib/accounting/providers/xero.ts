import type {
  AccountOption, AccountingAuth, AccountingContact, AccountingExpense, AccountingInvoice, AccountingPayment, AccountingProduct,
  ConnectionContext, LiveAccountingProvider, PullPaymentsResult, PushResult, RemotePayment, RemoteRef,
} from "../types";
import { majorToMinor, xeroBankTransaction, xeroContact, xeroInvoice, xeroItem, xeroPayment, type XeroPayload } from "../mapping";

/**
 * Xero via the Accounting API (no SDK). App credentials come from
 * XERO_CLIENT_ID / XERO_CLIENT_SECRET. Every call carries the tenant header;
 * pulls use If-Modified-Since so unchanged payments are not re-read.
 */

const AUTH_URL = "https://login.xero.com/identity/connect/authorize";
const TOKEN_URL = "https://identity.xero.com/connect/token";
const CONNECTIONS_URL = "https://api.xero.com/connections";
const API = "https://api.xero.com/api.xro/2.0";
const SCOPES = ["openid", "profile", "email", "offline_access", "accounting.transactions", "accounting.contacts", "accounting.settings"];
const TIMEOUT = 20_000;

function clientId() { return process.env.XERO_CLIENT_ID?.trim() ?? ""; }
function clientSecret() { return process.env.XERO_CLIENT_SECRET?.trim() ?? ""; }

async function api<T>(auth: AccountingAuth, conn: ConnectionContext, path: string, init: RequestInit = {}): Promise<T> {
  if (!conn.tenantId) throw new Error("Xero connection has no organisation (tenant) — reconnect it.");
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${auth.access_token ?? ""}`, Accept: "application/json", "Content-Type": "application/json", "Xero-Tenant-Id": conn.tenantId, ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(TIMEOUT),
  });
  if (res.status === 304) return {} as T;
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    let detail = text.slice(0, 300);
    try {
      const j = JSON.parse(text) as { Message?: string; Elements?: Array<{ ValidationErrors?: Array<{ Message: string }> }> };
      const ve = j.Elements?.flatMap((e) => e.ValidationErrors ?? []).map((v) => v.Message);
      detail = [j.Message, ...(ve ?? [])].filter(Boolean).join("; ") || detail;
    } catch { /* keep raw */ }
    const err = new Error(`Xero ${path.split("?")[0]} ${res.status}: ${detail}`) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
  return (await res.json()) as T;
}

async function token(params: Record<string, string>): Promise<AccountingAuth> {
  const basic = Buffer.from(`${clientId()}:${clientSecret()}`).toString("base64");
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Basic ${basic}` },
    body: new URLSearchParams(params).toString(),
    signal: AbortSignal.timeout(TIMEOUT),
  });
  const data = (await res.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string; expires_in?: number; error_description?: string; error?: string };
  if (!res.ok || !data.access_token) throw new Error(data.error_description ?? data.error ?? `Xero token endpoint returned ${res.status}`);
  return { access_token: data.access_token, refresh_token: data.refresh_token, expires_at: Date.now() + Math.max(60, data.expires_in ?? 1800) * 1000 - 30_000 };
}

type Collection = "Contacts" | "Invoices" | "Payments" | "BankTransactions" | "Items";
const ID_FIELD: Record<Collection, string> = { Contacts: "ContactID", Invoices: "InvoiceID", Payments: "PaymentID", BankTransactions: "BankTransactionID", Items: "ItemID" };

async function upsert(auth: AccountingAuth, conn: ConnectionContext, collection: Collection, payload: XeroPayload, existing: RemoteRef | null): Promise<PushResult> {
  const idField = ID_FIELD[collection];
  const body = existing ? { [collection]: [{ ...payload, [idField]: existing.remoteId }] } : { [collection]: [payload] };
  // POST on Xero creates or updates (by id); Payments are create-only so a known payment is returned as-is.
  if (existing && collection === "Payments") return { remoteId: existing.remoteId, remoteUpdatedAt: null, payload };
  const out = await api<Record<string, Array<Record<string, unknown>>>>(auth, conn, `/${collection}?summarizeErrors=false`, { method: "POST", body: JSON.stringify(body) });
  const row = out[collection]?.[0];
  if (!row) throw new Error(`Xero returned no ${collection} element`);
  const errs = (row.ValidationErrors as Array<{ Message: string }> | undefined) ?? [];
  if (errs.length) throw new Error(`Xero rejected ${collection}: ${errs.map((e) => e.Message).join("; ")}`);
  return { remoteId: String(row[idField]), remoteUpdatedAt: parseXeroDate(row.UpdatedDateUTC as string | undefined), payload };
}

/** Xero dates look like "/Date(1700000000000+0000)/". */
export function parseXeroDate(v: string | undefined | null): string | null {
  if (!v) return null;
  const m = /\/Date\((\d+)/.exec(v);
  if (m) return new Date(Number(m[1])).toISOString();
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export const xeroProvider: LiveAccountingProvider = {
  id: "xero",
  label: "Xero",
  configured: () => Boolean(clientId() && clientSecret()),
  unavailableReason: () => (clientId() && clientSecret() ? null : "Set XERO_CLIENT_ID and XERO_CLIENT_SECRET to connect Xero."),

  oauthStartUrl(state, redirectUri) {
    const q = new URLSearchParams({ client_id: clientId(), redirect_uri: redirectUri, response_type: "code", scope: SCOPES.join(" "), state });
    return `${AUTH_URL}?${q.toString()}`;
  },

  async exchangeCode(code, redirectUri) {
    const auth = await token({ grant_type: "authorization_code", code, redirect_uri: redirectUri });
    const res = await fetch(CONNECTIONS_URL, { headers: { Authorization: `Bearer ${auth.access_token}`, Accept: "application/json" }, signal: AbortSignal.timeout(TIMEOUT) });
    const conns = (await res.json().catch(() => [])) as Array<{ tenantId: string; tenantName?: string; tenantType?: string }>;
    const org = conns.find((c) => c.tenantType === "ORGANISATION") ?? conns[0];
    if (!org) throw new Error("Xero returned no authorised organisation.");
    return { auth, realmId: null, tenantId: org.tenantId, companyName: org.tenantName ?? null };
  },

  async refresh(auth) {
    if (!auth.refresh_token) throw new Error("Xero connection has no refresh token — reconnect it.");
    const next = await token({ grant_type: "refresh_token", refresh_token: auth.refresh_token });
    return { ...auth, ...next, refresh_token: next.refresh_token ?? auth.refresh_token };
  },

  async listAccounts(auth, conn): Promise<AccountOption[]> {
    const r = await api<{ Accounts?: Array<{ AccountID: string; Code?: string; Name: string; Type: string; Class?: string; Status?: string }> }>(auth, conn, `/Accounts?where=${encodeURIComponent('Status=="ACTIVE"')}`);
    const out: AccountOption[] = (r.Accounts ?? []).map((a) => ({
      // Invoice/BankTransaction lines take AccountCode; Payments take AccountID. Bank accounts expose the id, others the code.
      id: a.Type === "BANK" ? a.AccountID : (a.Code ?? a.AccountID),
      name: a.Name,
      code: a.Code ?? null,
      type: a.Type === "BANK" ? "bank" : a.Class === "REVENUE" ? "income" : a.Class === "EXPENSE" ? "expense" : "other",
    }));
    const taxes = await api<{ TaxRates?: Array<{ TaxType: string; Name: string; Status?: string }> }>(auth, conn, `/TaxRates`).catch(() => ({ TaxRates: [] as Array<{ TaxType: string; Name: string; Status?: string }> }));
    for (const t of taxes.TaxRates ?? []) if (t.Status !== "DELETED") out.push({ id: t.TaxType, name: t.Name, code: null, type: "tax" });
    return out;
  },

  async pushCustomer(auth, conn, contact: AccountingContact, existing) { return upsert(auth, conn, "Contacts", xeroContact(contact), existing); },
  async pushInvoice(auth, conn, invoice: AccountingInvoice, existing) { return upsert(auth, conn, "Invoices", xeroInvoice(invoice, conn.settings), existing); },
  async pushPayment(auth, conn, payment: AccountingPayment, existing) { return upsert(auth, conn, "Payments", xeroPayment(payment, conn.settings), existing); },
  async pushExpense(auth, conn, expense: AccountingExpense, existing) { return upsert(auth, conn, "BankTransactions", xeroBankTransaction(expense, conn.settings), existing); },
  async pushItem(auth, conn, product: AccountingProduct, existing) { return upsert(auth, conn, "Items", xeroItem(product, conn.settings), existing); },

  async pullPayments(auth, conn, cursor): Promise<PullPaymentsResult> {
    const headers: Record<string, string> = {};
    if (cursor) headers["If-Modified-Since"] = new Date(cursor).toUTCString();
    const r = await api<{ Payments?: Array<{ PaymentID: string; Status?: string; PaymentType?: string; Amount?: number; Date?: string; CurrencyRate?: number; Invoice?: { InvoiceID: string; CurrencyCode?: string; Type?: string } }> }>(
      auth, conn, `/Payments?where=${encodeURIComponent('Status=="AUTHORISED"')}`, { headers }
    );
    const payments: RemotePayment[] = [];
    for (const p of r.Payments ?? []) {
      if (!p.Invoice?.InvoiceID || p.PaymentType === "ACCPAYPAYMENT") continue;
      const cur = p.Invoice.CurrencyCode ?? null;
      payments.push({ remoteId: p.PaymentID, remoteInvoiceId: p.Invoice.InvoiceID, amountMinor: majorToMinor(p.Amount ?? 0, cur ?? "USD"), currency: cur, paidAt: parseXeroDate(p.Date) });
    }
    return { payments, cursor: new Date().toISOString() };
  },
};
