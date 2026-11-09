import { randomUUID } from "crypto";
import { query, queryOne } from "@/lib/dsql";
import type {
  AccountOption, AccountingBill, AccountingContact, AccountingExpense, AccountingSupplier, AccountingInvoice, AccountingPayment, AccountingProduct,
  ConnectionContext, LiveAccountingProvider, PullPaymentsResult, PushResult, RemotePayment, RemoteRef,
} from "../types";
import { qboBill, qboCustomer, qboInvoice, qboItem, qboPayment, qboPurchase, qboVendor } from "../mapping";

/**
 * In-database fake accounting system. Pushed payloads (QuickBooks-shaped, so
 * the UI shows "what would be sent") land in `accounting_sim_objects`; the dev
 * route /api/accounting/simulate-payment inserts remote payments that
 * `pullPayments` then returns, exercising the full pull → recordPayment path.
 */

export const SIM_ACCOUNTS: AccountOption[] = [
  { id: "sim-income-sales", name: "Sales", type: "income", code: "4000" },
  { id: "sim-income-services", name: "Service revenue", type: "income", code: "4100" },
  { id: "sim-expense-cogs", name: "Cost of goods sold", type: "expense", code: "5000" },
  { id: "sim-expense-general", name: "General expenses", type: "expense", code: "6000" },
  { id: "sim-bank-checking", name: "Business checking", type: "bank", code: "1000" },
  { id: "sim-bank-undeposited", name: "Undeposited funds", type: "bank", code: "1200" },
  { id: "sim-tax-standard", name: "Standard tax", type: "tax" },
  { id: "sim-tax-zero", name: "Zero rated", type: "tax" },
];

export interface SimObjectRow {
  id: string;
  connection_id: string;
  kind: string;
  remote_id: string;
  source: string;
  payload: string;
  created_at: string;
  updated_at: string;
}

async function store(userId: string, conn: ConnectionContext, kind: string, payload: unknown, existing: RemoteRef | null): Promise<PushResult> {
  const remoteId = existing?.remoteId ?? `sim_${kind.toLowerCase()}_${randomUUID().slice(0, 8)}`;
  const body = JSON.stringify(payload);
  const row = await queryOne<{ id: string }>(`SELECT id FROM accounting_sim_objects WHERE connection_id = $1 AND kind = $2 AND remote_id = $3`, [conn.id, kind, remoteId]);
  if (row) await query(`UPDATE accounting_sim_objects SET payload = $2, updated_at = NOW() WHERE id = $1`, [row.id, body]);
  else {
    await query(
      `INSERT INTO accounting_sim_objects (id, user_id, connection_id, kind, remote_id, source, payload) VALUES ($1, $2, $3, $4, $5, 'push', $6)`,
      [randomUUID(), userId, conn.id, kind, remoteId, body]
    );
  }
  return { remoteId, remoteUpdatedAt: new Date().toISOString(), payload };
}

/** The connection's owner is needed for the user_id column; it rides along in the context id lookup. */
async function ownerOf(connId: string): Promise<string> {
  const r = await queryOne<{ user_id: string }>(`SELECT user_id FROM accounting_connections WHERE id = $1`, [connId]);
  if (!r) throw new Error("Simulated connection not found");
  return r.user_id;
}

export const simulatedProvider: LiveAccountingProvider = {
  id: "simulated",
  label: "Simulated ledger",
  configured: () => true,
  unavailableReason: () => null,
  oauthStartUrl: () => "/api/accounting/connect/simulated",
  async exchangeCode() {
    return { auth: {}, realmId: "sim-realm", tenantId: null, companyName: "Simulated Books Ltd" };
  },
  async refresh(auth) { return auth; },
  async listAccounts() { return SIM_ACCOUNTS; },
  async pushCustomer(_a, conn, contact: AccountingContact, existing) { return store(await ownerOf(conn.id), conn, "Customer", qboCustomer(contact), existing); },
  async pushInvoice(_a, conn, invoice: AccountingInvoice, existing) { return store(await ownerOf(conn.id), conn, "Invoice", qboInvoice(invoice, conn.settings), existing); },
  async pushPayment(_a, conn, payment: AccountingPayment, existing) { return store(await ownerOf(conn.id), conn, "Payment", qboPayment(payment, conn.settings), existing); },
  async pushExpense(_a, conn, expense: AccountingExpense, existing) { return store(await ownerOf(conn.id), conn, "Purchase", qboPurchase(expense, conn.settings), existing); },
  async pushItem(_a, conn, product: AccountingProduct, existing) { return store(await ownerOf(conn.id), conn, "Item", qboItem(product, conn.settings), existing); },
  async pushVendor(_a, conn, supplier: AccountingSupplier, existing) { return store(await ownerOf(conn.id), conn, "Vendor", qboVendor(supplier), existing); },
  async pushBill(_a, conn, bill: AccountingBill, existing) { return store(await ownerOf(conn.id), conn, "Bill", qboBill(bill, conn.settings), existing); },

  async pullPayments(_a, conn, cursor): Promise<PullPaymentsResult> {
    const rows = await query<SimObjectRow>(
      `SELECT id, connection_id, kind, remote_id, source, payload, created_at, updated_at FROM accounting_sim_objects
        WHERE connection_id = $1 AND kind = 'Payment' AND source = 'remote' AND created_at > COALESCE($2::timestamptz, 'epoch'::timestamptz)
        ORDER BY created_at ASC LIMIT 200`,
      [conn.id, cursor]
    );
    const payments: RemotePayment[] = [];
    for (const r of rows) {
      try {
        const p = JSON.parse(r.payload) as { invoice_remote_id: string; amount_minor: number; currency: string | null; paid_at?: string | null };
        payments.push({ remoteId: r.remote_id, remoteInvoiceId: p.invoice_remote_id, amountMinor: Number(p.amount_minor), currency: p.currency, paidAt: p.paid_at ?? r.created_at });
      } catch { /* skip malformed */ }
    }
    const last = rows[rows.length - 1];
    return { payments, cursor: last ? new Date(last.created_at).toISOString() : cursor };
  },
};

/** Dev helper: a payment "recorded in the accounting system" against a pushed invoice. */
export async function createSimulatedRemotePayment(userId: string, connId: string, input: { invoiceRemoteId: string; amountMinor: number; currency: string }): Promise<string> {
  const remoteId = `sim_remote_payment_${randomUUID().slice(0, 8)}`;
  await query(
    `INSERT INTO accounting_sim_objects (id, user_id, connection_id, kind, remote_id, source, payload) VALUES ($1, $2, $3, 'Payment', $4, 'remote', $5)`,
    [randomUUID(), userId, connId, remoteId, JSON.stringify({ invoice_remote_id: input.invoiceRemoteId, amount_minor: input.amountMinor, currency: input.currency, paid_at: new Date().toISOString() })]
  );
  return remoteId;
}

export async function listSimulatedObjects(userId: string, connId: string, limit = 50): Promise<Array<Omit<SimObjectRow, "payload"> & { payload: unknown }>> {
  const rows = await query<SimObjectRow>(
    `SELECT id, connection_id, kind, remote_id, source, payload, created_at, updated_at FROM accounting_sim_objects WHERE user_id = $1 AND connection_id = $2 ORDER BY updated_at DESC LIMIT $3`,
    [userId, connId, Math.min(Math.max(limit, 1), 200)]
  );
  return rows.map((r) => {
    let payload: unknown = null;
    try { payload = JSON.parse(r.payload); } catch { payload = r.payload; }
    return { ...r, payload };
  });
}
