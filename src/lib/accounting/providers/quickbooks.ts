import type {
  AccountOption, AccountingAuth, AccountingBill, AccountingBillPayment, AccountingContact, AccountingExpense, AccountingInvoice, AccountingPayment, AccountingProduct, AccountingSupplier,
  ConnectionContext, LiveAccountingProvider, PullPaymentsResult, PushResult, RemotePayment, RemoteRef,
} from "../types";
import { majorToMinor, qboBill, qboBillPayment, qboCustomer, qboInvoice, qboItem, qboPayment, qboPurchase, qboVendor, type QboPayload } from "../mapping";

/**
 * QuickBooks Online via the REST API (no SDK). App credentials come from
 * QBO_CLIENT_ID / QBO_CLIENT_SECRET; QBO_ENV=production selects the live base
 * URL (default sandbox). Every entity update carries the current SyncToken
 * (fetched just before the update), and pulls use Change Data Capture.
 */

const AUTH_URL = "https://appcenter.intuit.com/connect/oauth2";
const TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";
const SCOPES = ["com.intuit.quickbooks.accounting"];
const TIMEOUT = 20_000;
const MINOR_VERSION = "73";

function clientId() { return process.env.QBO_CLIENT_ID?.trim() ?? ""; }
function clientSecret() { return process.env.QBO_CLIENT_SECRET?.trim() ?? ""; }
export function qboBaseUrl(env: Record<string, string | undefined> = process.env): string {
  return env.QBO_ENV?.trim().toLowerCase() === "production" ? "https://quickbooks.api.intuit.com" : "https://sandbox-quickbooks.api.intuit.com";
}

interface QboError extends Error { status?: number; code?: string }

async function api<T>(auth: AccountingAuth, conn: ConnectionContext, path: string, init: RequestInit = {}): Promise<T> {
  if (!conn.realmId) throw new Error("QuickBooks connection has no company (realmId) — reconnect it.");
  const sep = path.includes("?") ? "&" : "?";
  const res = await fetch(`${qboBaseUrl()}/v3/company/${encodeURIComponent(conn.realmId)}${path}${sep}minorversion=${MINOR_VERSION}`, {
    ...init,
    headers: { Authorization: `Bearer ${auth.access_token ?? ""}`, Accept: "application/json", "Content-Type": "application/json", ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(TIMEOUT),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    let code: string | undefined;
    try {
      const j = JSON.parse(text) as { Fault?: { Error?: Array<{ code?: string; Message?: string; Detail?: string }> } };
      const e = j.Fault?.Error?.[0];
      code = e?.code;
      const err: QboError = new Error(`QuickBooks ${path.split("?")[0]} ${res.status}: ${e?.Message ?? ""} ${e?.Detail ?? ""}`.trim());
      err.status = res.status; err.code = code;
      throw err;
    } catch (e) {
      if (e instanceof Error && (e as QboError).status) throw e;
    }
    const err: QboError = new Error(`QuickBooks ${path.split("?")[0]} returned ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}`);
    err.status = res.status;
    throw err;
  }
  return (await res.json()) as T;
}

async function token(params: Record<string, string>): Promise<AccountingAuth> {
  const basic = Buffer.from(`${clientId()}:${clientSecret()}`).toString("base64");
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json", Authorization: `Basic ${basic}` },
    body: new URLSearchParams(params).toString(),
    signal: AbortSignal.timeout(TIMEOUT),
  });
  const data = (await res.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string; expires_in?: number; x_refresh_token_expires_in?: number; error_description?: string; error?: string };
  if (!res.ok || !data.access_token) throw new Error(data.error_description ?? data.error ?? `Intuit token endpoint returned ${res.status}`);
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: Date.now() + Math.max(60, data.expires_in ?? 3600) * 1000 - 30_000,
    refresh_expires_at: data.x_refresh_token_expires_in ? Date.now() + data.x_refresh_token_expires_in * 1000 : undefined,
  };
}

type Entity = "Customer" | "Invoice" | "Payment" | "Purchase" | "Item" | "Vendor" | "Bill" | "BillPayment";

async function readEntity(auth: AccountingAuth, conn: ConnectionContext, entity: Entity, id: string): Promise<{ Id: string; SyncToken: string; MetaData?: { LastUpdatedTime?: string } }> {
  const r = await api<Record<string, { Id: string; SyncToken: string; MetaData?: { LastUpdatedTime?: string } }>>(auth, conn, `/${entity.toLowerCase()}/${encodeURIComponent(id)}`);
  return r[entity];
}

/** Create or sparse-update with the live SyncToken. Retries once on a stale-object fault (5010). */
async function upsert(auth: AccountingAuth, conn: ConnectionContext, entity: Entity, payload: QboPayload, existing: RemoteRef | null): Promise<PushResult> {
  const path = `/${entity.toLowerCase()}`;
  const send = async (body: QboPayload) =>
    api<Record<string, { Id: string; SyncToken: string; MetaData?: { LastUpdatedTime?: string } }>>(auth, conn, path, { method: "POST", body: JSON.stringify(body) });
  let body: QboPayload = payload;
  if (existing) {
    const current = await readEntity(auth, conn, entity, existing.remoteId);
    body = { ...payload, Id: existing.remoteId, SyncToken: current.SyncToken, sparse: true };
  }
  let out;
  try {
    out = await send(body);
  } catch (err) {
    if (existing && (err as QboError).code === "5010") {
      const current = await readEntity(auth, conn, entity, existing.remoteId);
      out = await send({ ...body, SyncToken: current.SyncToken });
    } else throw err;
  }
  const row = out[entity];
  return { remoteId: row.Id, remoteUpdatedAt: row.MetaData?.LastUpdatedTime ?? null, meta: { syncToken: row.SyncToken }, payload };
}

/** Surface a "Duplicate Name Exists" (6240) as the existing customer so re-connects do not fork records. */
async function findCustomerByName(auth: AccountingAuth, conn: ConnectionContext, name: string): Promise<string | null> {
  const q = `select Id from Customer where DisplayName = '${name.replace(/'/g, "\\'")}'`;
  const r = await api<{ QueryResponse?: { Customer?: Array<{ Id: string }> } }>(auth, conn, `/query?query=${encodeURIComponent(q)}`);
  return r.QueryResponse?.Customer?.[0]?.Id ?? null;
}

export const quickbooksProvider: LiveAccountingProvider = {
  id: "quickbooks",
  label: "QuickBooks Online",
  configured: () => Boolean(clientId() && clientSecret()),
  unavailableReason: () => (clientId() && clientSecret() ? null : "Set QBO_CLIENT_ID and QBO_CLIENT_SECRET to connect QuickBooks Online."),

  oauthStartUrl(state, redirectUri) {
    const q = new URLSearchParams({ client_id: clientId(), redirect_uri: redirectUri, response_type: "code", scope: SCOPES.join(" "), state });
    return `${AUTH_URL}?${q.toString()}`;
  },

  async exchangeCode(code, redirectUri, realm) {
    const auth = await token({ grant_type: "authorization_code", code, redirect_uri: redirectUri });
    const realmId = realm?.trim() || null;
    let companyName: string | null = null;
    if (realmId) {
      try {
        const info = await api<{ CompanyInfo?: { CompanyName?: string } }>(auth, { id: "", realmId, tenantId: null, settings: {} }, `/companyinfo/${encodeURIComponent(realmId)}`);
        companyName = info.CompanyInfo?.CompanyName ?? null;
      } catch (err) {
        console.warn("[accounting/qbo] companyinfo failed:", err instanceof Error ? err.message : err);
      }
    }
    return { auth, realmId, tenantId: null, companyName };
  },

  async refresh(auth) {
    if (!auth.refresh_token) throw new Error("QuickBooks connection has no refresh token — reconnect it.");
    const next = await token({ grant_type: "refresh_token", refresh_token: auth.refresh_token });
    return { ...auth, ...next, refresh_token: next.refresh_token ?? auth.refresh_token };
  },

  async listAccounts(auth, conn): Promise<AccountOption[]> {
    const r = await api<{ QueryResponse?: { Account?: Array<{ Id: string; Name: string; AccountType: string; AcctNum?: string; Active?: boolean }> } }>(
      auth, conn, `/query?query=${encodeURIComponent("select Id, Name, AccountType, AcctNum, Active from Account where Active = true maxresults 1000")}`
    );
    const accounts = (r.QueryResponse?.Account ?? []).map((a) => ({ id: a.Id, name: a.Name, code: a.AcctNum ?? null, type: mapAccountType(a.AccountType) }));
    const taxes = await api<{ QueryResponse?: { TaxCode?: Array<{ Id: string; Name: string; Active?: boolean }> } }>(
      auth, conn, `/query?query=${encodeURIComponent("select Id, Name, Active from TaxCode where Active = true maxresults 200")}`
    ).catch(() => ({ QueryResponse: { TaxCode: [] as Array<{ Id: string; Name: string }> } }));
    for (const t of taxes.QueryResponse?.TaxCode ?? []) accounts.push({ id: t.Id, name: t.Name, code: null, type: "tax" });
    return accounts;
  },

  async pushCustomer(auth, conn, contact: AccountingContact, existing) {
    const payload = qboCustomer(contact);
    try {
      return await upsert(auth, conn, "Customer", payload, existing);
    } catch (err) {
      if (!existing && (err as QboError).code === "6240") {
        const id = await findCustomerByName(auth, conn, contact.full_name);
        if (id) return upsert(auth, conn, "Customer", payload, { remoteId: id, meta: null });
      }
      throw err;
    }
  },
  async pushInvoice(auth, conn, invoice: AccountingInvoice, existing) {
    return upsert(auth, conn, "Invoice", qboInvoice(invoice, conn.settings), existing);
  },
  async pushPayment(auth, conn, payment: AccountingPayment, existing) {
    return upsert(auth, conn, "Payment", qboPayment(payment, conn.settings), existing);
  },
  async pushExpense(auth, conn, expense: AccountingExpense, existing) {
    return upsert(auth, conn, "Purchase", qboPurchase(expense, conn.settings), existing);
  },
  async pushItem(auth, conn, product: AccountingProduct, existing) {
    return upsert(auth, conn, "Item", qboItem(product, conn.settings), existing);
  },
  async pushVendor(auth, conn, supplier: AccountingSupplier, existing) {
    return upsert(auth, conn, "Vendor", qboVendor(supplier), existing);
  },
  async pushBill(auth, conn, bill: AccountingBill, existing) {
    return upsert(auth, conn, "Bill", qboBill(bill, conn.settings), existing);
  },
  async pushBillPayment(auth, conn, payment: AccountingBillPayment, existing) {
    return upsert(auth, conn, "BillPayment", qboBillPayment(payment, conn.settings), existing);
  },

  /** CDC: every Payment changed since the cursor (max 30 days back per Intuit; we clamp). */
  async pullPayments(auth, conn, cursor): Promise<PullPaymentsResult> {
    const floor = Date.now() - 29 * 86_400_000;
    const sinceMs = cursor ? Math.max(new Date(cursor).getTime() || floor, floor) : floor;
    const since = new Date(sinceMs).toISOString();
    const r = await api<{ CDCResponse?: Array<{ QueryResponse?: Array<{ Payment?: Array<QboPaymentRow> }> }> }>(
      auth, conn, `/cdc?entities=Payment&changedSince=${encodeURIComponent(since)}`
    );
    const payments: RemotePayment[] = [];
    for (const block of r.CDCResponse ?? []) {
      for (const qr of block.QueryResponse ?? []) {
        for (const p of qr.Payment ?? []) {
          if (p.status === "Deleted") continue;
          const cur = p.CurrencyRef?.value ?? null;
          for (const line of p.Line ?? []) {
            const inv = (line.LinkedTxn ?? []).find((l) => l.TxnType === "Invoice");
            if (!inv) continue;
            payments.push({ remoteId: p.Id, remoteInvoiceId: inv.TxnId, amountMinor: majorToMinor(line.Amount ?? p.TotalAmt ?? 0, cur ?? "USD"), currency: cur, paidAt: p.TxnDate ?? null });
          }
        }
      }
    }
    return { payments, cursor: new Date().toISOString() };
  },
};

interface QboPaymentRow {
  Id: string;
  status?: string;
  TotalAmt?: number;
  TxnDate?: string;
  CurrencyRef?: { value?: string };
  Line?: Array<{ Amount?: number; LinkedTxn?: Array<{ TxnId: string; TxnType: string }> }>;
}

export function mapAccountType(t: string): string {
  const s = t.toLowerCase();
  if (s === "income" || s === "other income") return "income";
  if (s.includes("expense") || s === "cost of goods sold") return "expense";
  if (s === "bank" || s === "other current asset") return "bank";
  return "other";
}
