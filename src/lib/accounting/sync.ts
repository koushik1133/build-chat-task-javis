import { query, queryOne } from "@/lib/dsql";
import { emitEvent } from "@/lib/events/bus";
import { recordPayment } from "@/lib/money/invoices";
import { parseItems } from "@/lib/money/items";
import {
  ensureFreshAuth, getConnectionById, getLink, getLiveProvider, listAllConnected, listConnectedForUser, logSync,
  markConnectionError, markConnectionSynced, toContext, upsertLink,
} from "./connections";
import { payloadHash, pulledPaymentProvider, selectNewRemotePayments, stripVolatile } from "./mapping";
import type {
  AccountingBillPayment,
  AccountingBill, AccountingBillLine, AccountingConnectionRow, AccountingContact, AccountingEntityKind, AccountingExpense, AccountingInvoice, AccountingInvoiceLine, AccountingPayment,
  AccountingProduct, AccountingSupplier, LiveAccountingProvider, PushResult, RemoteRef,
} from "./types";
import { parsePoLines } from "@/lib/procurement/purchase-orders";

/**
 * Push/pull orchestration.
 *
 *   pushEntity(connId, kind, id)   dependency-ordered push (customer → invoice → payment), hash-skip
 *   pushDue(limit)                 cron: entities changed since their last push, or never pushed
 *   pullDue(limit)                 cron: payments recorded in the accounting system → recordPayment
 *   syncConnection(id)             "Sync now": pushDue for one connection + pull
 *   processAccountingEvents(limit) cron: scans new events (own cursor) and auto-pushes
 *
 * A failure on one entity is logged on its link and in accounting_sync_log and
 * never aborts the batch. Auth errors (401) mark the connection `error`.
 */

export interface PushOutcome {
  kind: AccountingEntityKind;
  id: string;
  status: "ok" | "skipped" | "error";
  remoteId?: string | null;
  message?: string;
}

const PUSHABLE_INVOICE_STATUSES = ["sent", "partially_paid", "paid", "overdue"];

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
function isAuthError(err: unknown): boolean {
  const s = (err as { status?: number } | null)?.status;
  return s === 401 || /reconnect|refresh token/i.test(errMsg(err));
}

async function refOf(connId: string, kind: AccountingEntityKind, id: string): Promise<{ link: Awaited<ReturnType<typeof getLink>>; ref: RemoteRef | null }> {
  const link = await getLink(connId, kind, id);
  if (!link?.remote_id) return { link, ref: null };
  let meta: Record<string, string> | null = null;
  if (link.remote_meta) {
    try { meta = JSON.parse(link.remote_meta) as Record<string, string>; } catch { meta = null; }
  }
  return { link, ref: { remoteId: link.remote_id, meta } };
}

interface Session {
  conn: AccountingConnectionRow;
  provider: LiveAccountingProvider;
  auth: Awaited<ReturnType<typeof ensureFreshAuth>>;
  ctx: ReturnType<typeof toContext>;
}

async function openSession(conn: AccountingConnectionRow): Promise<Session> {
  const provider = getLiveProvider(conn.provider);
  if (!provider) throw new Error(`Unknown accounting provider ${conn.provider}`);
  const auth = await ensureFreshAuth(conn);
  return { conn, provider, auth, ctx: toContext(conn) };
}

/** Compare the would-be payload against the stored hash; run `send` only when something changed. */
async function pushWithHash(
  s: Session, kind: AccountingEntityKind, id: string, payload: Record<string, unknown>,
  send: (existing: RemoteRef | null) => Promise<PushResult>
): Promise<PushOutcome> {
  const { link, ref } = await refOf(s.conn.id, kind, id);
  const hash = payloadHash(stripVolatile(payload));
  if (ref && link?.hash === hash && !link.error) {
    return { kind, id, status: "skipped", remoteId: ref.remoteId, message: "unchanged" };
  }
  try {
    const res = await send(ref);
    // Store the hash of the SAME neutral payload compared above (not the
    // provider-shaped `res.payload`), otherwise the unchanged-skip never fires.
    await upsertLink(s.conn.user_id, s.conn.id, kind, id, { remote_id: res.remoteId, remote_updated_at: res.remoteUpdatedAt, remote_meta: res.meta ?? null, hash, error: null, pushed: true });
    await logSync(s.conn.user_id, s.conn.id, { direction: "push", kind, entityId: id, remoteId: res.remoteId, status: "ok", message: ref ? "updated" : "created" });
    return { kind, id, status: "ok", remoteId: res.remoteId };
  } catch (err) {
    const message = errMsg(err);
    await upsertLink(s.conn.user_id, s.conn.id, kind, id, { error: message.slice(0, 1000) });
    await logSync(s.conn.user_id, s.conn.id, { direction: "push", kind, entityId: id, remoteId: ref?.remoteId ?? null, status: "error", message });
    if (isAuthError(err)) await markConnectionError(s.conn.id, message, true);
    return { kind, id, status: "error", remoteId: ref?.remoteId ?? null, message };
  }
}

// ── Loaders (domain → provider-neutral shapes) ───────────────────────────────

async function loadContact(dataId: string, id: string): Promise<AccountingContact | null> {
  const r = await queryOne<{ id: string; full_name: string; email: string | null; phone: string | null; company: string | null }>(
    `SELECT id, full_name, email, phone, company FROM crm_contacts WHERE id = $1 AND user_id = $2`, [id, dataId]
  );
  return r ? { id: r.id, full_name: r.full_name, email: r.email, phone: r.phone, company: r.company } : null;
}

interface InvoiceRowLite {
  id: string; contact_id: string | null; number: string; status: string; currency: string; subtotal_minor: string | number; tax_minor: string | number;
  total_minor: string | number; due_at: string | null; created_at: string; notes: string | null; items: string | null;
}

async function loadInvoice(dataId: string, id: string): Promise<InvoiceRowLite | null> {
  return queryOne<InvoiceRowLite>(`SELECT id, contact_id, number, status, currency, subtotal_minor, tax_minor, total_minor, due_at, created_at, notes, items FROM invoices WHERE id = $1 AND user_id = $2`, [id, dataId]);
}

async function loadExpense(dataId: string, id: string): Promise<(AccountingExpense & { ref_kind: string | null }) | null> {
  const r = await queryOne<{ id: string; category: string; vendor: string | null; description: string | null; amount_minor: string | number; tax_minor: string | number; currency: string; spent_at: string; ref_kind: string | null }>(
    `SELECT id, category, vendor, description, amount_minor, tax_minor, currency, spent_at, ref_kind FROM expenses WHERE id = $1 AND user_id = $2`, [id, dataId]
  );
  return r ? { ...r, amount_minor: Number(r.amount_minor), tax_minor: Number(r.tax_minor), spent_at: new Date(r.spent_at).toISOString() } : null;
}

async function loadSupplier(dataId: string, id: string): Promise<AccountingSupplier | null> {
  const r = await queryOne<{ id: string; name: string; email: string | null; phone: string | null; tax_number: string | null }>(
    `SELECT id, name, email, phone, tax_number FROM suppliers WHERE id = $1 AND user_id = $2`, [id, dataId]
  );
  return r ? { id: r.id, name: r.name, email: r.email, phone: r.phone, tax_number: r.tax_number } : null;
}

interface BillRowLite {
  id: string; supplier_id: string; number: string; supplier_ref: string | null; status: string; currency: string; subtotal_minor: string | number; tax_minor: string | number;
  total_minor: string | number; issued_at: string | null; due_at: string | null; created_at: string; notes: string | null; items: string | null; supplier_name: string | null;
}

async function loadBill(dataId: string, id: string): Promise<BillRowLite | null> {
  return queryOne<BillRowLite>(
    `SELECT b.id, b.supplier_id, b.number, b.supplier_ref, b.status, b.currency, b.subtotal_minor, b.tax_minor, b.total_minor, b.issued_at, b.due_at, b.created_at, b.notes, b.items, s.name AS supplier_name
       FROM supplier_bills b LEFT JOIN suppliers s ON s.id = b.supplier_id WHERE b.id = $1 AND b.user_id = $2`, [id, dataId]
  );
}

interface BillPaymentRowLite { id: string; bill_id: string; amount_minor: string | number; currency: string; method: string | null; ref: string | null; paid_at: string; supplier_id: string }

async function loadBillPayment(dataId: string, id: string): Promise<BillPaymentRowLite | null> {
  return queryOne<BillPaymentRowLite>(
    `SELECT p.id, p.bill_id, p.amount_minor, p.currency, p.method, p.ref, p.paid_at, b.supplier_id
       FROM bill_payments p JOIN supplier_bills b ON b.id = p.bill_id WHERE p.id = $1 AND p.user_id = $2`, [id, dataId]
  );
}

async function loadProduct(dataId: string, id: string): Promise<AccountingProduct | null> {
  const r = await queryOne<{ id: string; sku: string | null; name: string; description: string | null; kind: string; unit_price_minor: string | number; cost_minor: string | number; currency: string; tax_rate_bp: number; track_stock: boolean }>(
    `SELECT id, sku, name, description, kind, unit_price_minor, cost_minor, currency, tax_rate_bp, track_stock FROM products WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`, [id, dataId]
  );
  return r ? { ...r, unit_price_minor: Number(r.unit_price_minor), cost_minor: Number(r.cost_minor), tax_rate_bp: Number(r.tax_rate_bp) } : null;
}

async function loadPayment(dataId: string, id: string): Promise<{ id: string; invoice_id: string; provider: string; provider_ref: string | null; amount_minor: number; currency: string; created_at: string; contact_id: string | null } | null> {
  const r = await queryOne<{ id: string; invoice_id: string; provider: string; provider_ref: string | null; amount_minor: string | number; currency: string; created_at: string; contact_id: string | null }>(
    `SELECT p.id, p.invoice_id, p.provider, p.provider_ref, p.amount_minor, p.currency, p.created_at, i.contact_id
       FROM invoice_payments p JOIN invoices i ON i.id = p.invoice_id WHERE p.id = $1 AND i.user_id = $2 AND p.status = 'succeeded'`, [id, dataId]
  );
  return r ? { ...r, amount_minor: Number(r.amount_minor), created_at: new Date(r.created_at).toISOString() } : null;
}

// ── Pushers ──────────────────────────────────────────────────────────────────

async function pushContact(s: Session, id: string): Promise<PushOutcome> {
  const c = await loadContact(s.conn.user_id, id);
  if (!c) return { kind: "contact", id, status: "error", message: "Contact not found" };
  // Payload hash: provider-neutral shape (what we would send is derived deterministically from it).
  return pushWithHash(s, "contact", id, { ...c }, (existing) => s.provider.pushCustomer(s.auth, s.ctx, c, existing));
}

async function pushProduct(s: Session, id: string): Promise<PushOutcome> {
  const p = await loadProduct(s.conn.user_id, id);
  if (!p) return { kind: "product", id, status: "error", message: "Product not found" };
  return pushWithHash(s, "product", id, { ...p, settings: s.ctx.settings }, (existing) => s.provider.pushItem(s.auth, s.ctx, p, existing));
}

async function pushInvoice(s: Session, id: string, opts: { force?: boolean } = {}): Promise<PushOutcome> {
  const row = await loadInvoice(s.conn.user_id, id);
  if (!row) return { kind: "invoice", id, status: "error", message: "Invoice not found" };
  if (!opts.force && !PUSHABLE_INVOICE_STATUSES.includes(row.status)) {
    return { kind: "invoice", id, status: "skipped", message: `invoice is ${row.status}` };
  }
  let contactRemoteId: string | null = null;
  if (row.contact_id) {
    const c = await pushContact(s, row.contact_id);
    if (c.status === "error") return { kind: "invoice", id, status: "error", message: `Customer push failed: ${c.message}` };
    contactRemoteId = c.remoteId ?? null;
  } else {
    return { kind: "invoice", id, status: "error", message: "Invoice has no contact; accounting systems require a customer" };
  }
  const items: AccountingInvoiceLine[] = [];
  for (const it of parseItems(row.items)) {
    let itemRemoteId: string | null = null;
    if (it.product_id) {
      const link = await getLink(s.conn.id, "product", it.product_id);
      itemRemoteId = link?.remote_id ?? null;
    }
    items.push({ description: it.description, qty: it.qty, unit_minor: it.unit_minor, tax_rate_bp: it.tax_rate_bp ?? 0, product_id: it.product_id ?? null, item_remote_id: itemRemoteId });
  }
  const inv: AccountingInvoice = {
    id: row.id, number: row.number, status: row.status, currency: row.currency, subtotal_minor: Number(row.subtotal_minor), tax_minor: Number(row.tax_minor),
    total_minor: Number(row.total_minor), due_at: row.due_at ? new Date(row.due_at).toISOString() : null, created_at: new Date(row.created_at).toISOString(), notes: row.notes, items, contact_remote_id: contactRemoteId,
  };
  // Status is excluded from the hash: paid/overdue flips are reflected by payments, not by re-sending the invoice.
  const { status: _st, ...hashable } = inv; void _st;
  return pushWithHash(s, "invoice", id, { ...hashable, settings: s.ctx.settings }, (existing) => s.provider.pushInvoice(s.auth, s.ctx, inv, existing));
}

async function pushPaymentEntity(s: Session, id: string): Promise<PushOutcome> {
  const p = await loadPayment(s.conn.user_id, id);
  if (!p) return { kind: "payment", id, status: "error", message: "Payment not found or not succeeded" };
  // Never echo back a payment we pulled from this very accounting system.
  if (p.provider === pulledPaymentProvider(s.conn.provider)) return { kind: "payment", id, status: "skipped", message: "originated in the accounting system" };
  const invOut = await pushInvoice(s, p.invoice_id, { force: true });
  if (invOut.status === "error" || !invOut.remoteId) return { kind: "payment", id, status: "error", message: `Invoice push failed: ${invOut.message ?? "no remote id"}` };
  let contactRemoteId: string | null = null;
  if (p.contact_id) contactRemoteId = (await getLink(s.conn.id, "contact", p.contact_id))?.remote_id ?? null;
  const pay: AccountingPayment = { id: p.id, invoice_id: p.invoice_id, amount_minor: p.amount_minor, currency: p.currency, provider: p.provider, provider_ref: p.provider_ref, created_at: p.created_at, invoice_remote_id: invOut.remoteId, contact_remote_id: contactRemoteId };
  return pushWithHash(s, "payment", id, { ...pay, settings: s.ctx.settings }, (existing) => s.provider.pushPayment(s.auth, s.ctx, pay, existing));
}

async function pushExpenseEntity(s: Session, id: string): Promise<PushOutcome> {
  const row = await loadExpense(s.conn.user_id, id);
  if (!row) return { kind: "expense", id, status: "error", message: "Expense not found" };
  // Bill payments are represented by the Bill itself in the accounting system; pushing the cash-out again would double count.
  if (row.ref_kind === "bill") return { kind: "expense", id, status: "skipped", message: "tracked via supplier bill" };
  const { ref_kind: _rk, ...e } = row; void _rk;
  return pushWithHash(s, "expense", id, { ...e, settings: s.ctx.settings }, (existing) => s.provider.pushExpense(s.auth, s.ctx, e, existing));
}

async function pushSupplier(s: Session, id: string): Promise<PushOutcome> {
  const sup = await loadSupplier(s.conn.user_id, id);
  if (!sup) return { kind: "supplier", id, status: "error", message: "Supplier not found" };
  return pushWithHash(s, "supplier", id, { ...sup }, (existing) => s.provider.pushVendor(s.auth, s.ctx, sup, existing));
}

const PUSHABLE_BILL_STATUSES = ["open", "partially_paid", "paid"];

async function pushBill(s: Session, id: string, opts: { force?: boolean } = {}): Promise<PushOutcome> {
  const row = await loadBill(s.conn.user_id, id);
  if (!row) return { kind: "bill", id, status: "error", message: "Bill not found" };
  if (!opts.force && !PUSHABLE_BILL_STATUSES.includes(row.status)) return { kind: "bill", id, status: "skipped", message: `bill is ${row.status}` };
  const sup = await pushSupplier(s, row.supplier_id);
  if (sup.status === "error") return { kind: "bill", id, status: "error", message: `Vendor push failed: ${sup.message}` };
  const items: AccountingBillLine[] = [];
  for (const it of parsePoLines(row.items)) {
    let itemRemoteId: string | null = null;
    if (it.product_id) itemRemoteId = (await getLink(s.conn.id, "product", it.product_id))?.remote_id ?? null;
    items.push({ description: it.description, qty: it.qty, unit_minor: it.unit_minor, tax_rate_bp: it.tax_rate_bp ?? 0, product_id: it.product_id ?? null, item_remote_id: itemRemoteId });
  }
  const bill: AccountingBill = {
    id: row.id, number: row.number, supplier_ref: row.supplier_ref, status: row.status, currency: row.currency, subtotal_minor: Number(row.subtotal_minor), tax_minor: Number(row.tax_minor),
    total_minor: Number(row.total_minor), issued_at: new Date(row.issued_at ?? row.created_at).toISOString(), due_at: row.due_at ? new Date(row.due_at).toISOString() : null,
    notes: row.notes, items, supplier_remote_id: sup.remoteId ?? null, supplier_name: row.supplier_name ?? "Supplier",
  };
  // Status excluded from the hash: paid flips are payments, not a re-send of the bill.
  const { status: _st, ...hashable } = bill; void _st;
  return pushWithHash(s, "bill", id, { ...hashable, settings: s.ctx.settings }, (existing) => s.provider.pushBill(s.auth, s.ctx, bill, existing));
}

async function pushBillPaymentEntity(s: Session, id: string): Promise<PushOutcome> {
  const p = await loadBillPayment(s.conn.user_id, id);
  if (!p) return { kind: "bill_payment", id, status: "error", message: "Bill payment not found" };
  const billOut = await pushBill(s, p.bill_id, { force: true });
  if (billOut.status === "error" || !billOut.remoteId) return { kind: "bill_payment", id, status: "error", message: `Bill push failed: ${billOut.message ?? "no remote id"}` };
  const supplierRemoteId = (await getLink(s.conn.id, "supplier", p.supplier_id))?.remote_id ?? null;
  const pay: AccountingBillPayment = {
    id: p.id, bill_id: p.bill_id, amount_minor: Number(p.amount_minor), currency: p.currency, method: p.method, ref: p.ref,
    paid_at: new Date(p.paid_at).toISOString(), bill_remote_id: billOut.remoteId, supplier_remote_id: supplierRemoteId,
  };
  return pushWithHash(s, "bill_payment", id, { ...pay, settings: s.ctx.settings }, (existing) => s.provider.pushBillPayment(s.auth, s.ctx, pay, existing));
}

/** Every payment recorded against a bill, pushed in order (used by the `supplier_bill.paid` event). */
async function pushBillPayments(s: Session, billId: string): Promise<PushOutcome[]> {
  const rows = await query<{ id: string }>(`SELECT id FROM bill_payments WHERE user_id = $1 AND bill_id = $2 ORDER BY paid_at ASC, created_at ASC`, [s.conn.user_id, billId]).catch(() => [] as Array<{ id: string }>);
  const out: PushOutcome[] = [];
  for (const r of rows) out.push(await pushBillPaymentEntity(s, r.id));
  return out;
}

/** Push one entity (and what it depends on) to one connection. */
export async function pushEntity(connectionId: string, kind: AccountingEntityKind, id: string, opts: { force?: boolean } = {}): Promise<PushOutcome> {
  const conn = await getConnectionById(connectionId);
  if (!conn) return { kind, id, status: "error", message: "Connection not found" };
  if (conn.status === "disabled") return { kind, id, status: "skipped", message: "connection disabled" };
  let s: Session;
  try {
    s = await openSession(conn);
  } catch (err) {
    const message = errMsg(err);
    await markConnectionError(conn.id, message, true);
    await logSync(conn.user_id, conn.id, { direction: "push", kind, entityId: id, status: "error", message });
    return { kind, id, status: "error", message };
  }
  const out = await pushForSession(s, kind, id, opts);
  if (out.status === "ok") {
    void emitEvent(conn.user_id, { type: "accounting.synced", entity: kind, entityId: id, data: { connection_id: conn.id, provider: conn.provider, remote_id: out.remoteId ?? null } });
  } else if (out.status === "error") {
    void emitEvent(conn.user_id, { type: "accounting.sync_failed", entity: kind, entityId: id, data: { connection_id: conn.id, provider: conn.provider, error: out.message ?? null } });
  }
  return out;
}

async function pushForSession(s: Session, kind: AccountingEntityKind, id: string, opts: { force?: boolean }): Promise<PushOutcome> {
  switch (kind) {
    case "contact": return pushContact(s, id);
    case "invoice": return pushInvoice(s, id, opts);
    case "payment": return pushPaymentEntity(s, id);
    case "expense": return pushExpenseEntity(s, id);
    case "product": return pushProduct(s, id);
    case "supplier": return pushSupplier(s, id);
    case "bill": return pushBill(s, id, opts);
    case "bill_payment": return pushBillPaymentEntity(s, id);
  }
}

/** Push a bill and then every payment on it (one connection). */
export async function pushBillWithPayments(connectionId: string, billId: string): Promise<PushOutcome[]> {
  const first = await pushEntity(connectionId, "bill", billId);
  if (first.status === "error") return [first];
  const conn = await getConnectionById(connectionId);
  if (!conn || conn.status === "disabled") return [first];
  const s = await openSession(conn).catch(() => null);
  if (!s) return [first];
  return [first, ...(await pushBillPayments(s, billId))];
}

/** Push to every connected integration of an org. */
export async function pushToAll(dataId: string, kind: AccountingEntityKind, id: string): Promise<PushOutcome[]> {
  const conns = await listConnectedForUser(dataId);
  const out: PushOutcome[] = [];
  for (const c of conns) out.push(await pushEntity(c.id, kind, id));
  return out;
}

// ── Due scans ────────────────────────────────────────────────────────────────

export interface DueResult { connections: number; pushed: number; skipped: number; errors: number }

async function dueForConnection(conn: AccountingConnectionRow, limit: number): Promise<Array<{ kind: AccountingEntityKind; id: string }>> {
  const settings = toContext(conn).settings;
  const out: Array<{ kind: AccountingEntityKind; id: string }> = [];
  const invoices = await query<{ id: string }>(
    `SELECT i.id FROM invoices i LEFT JOIN accounting_links l ON l.connection_id = $2 AND l.entity_kind = 'invoice' AND l.entity_id = i.id
      WHERE i.user_id = $1 AND i.status = ANY($3::text[]) AND (l.id IS NULL OR (l.error IS NULL AND i.updated_at > COALESCE(l.last_pushed_at, 'epoch'::timestamptz)))
      ORDER BY i.updated_at ASC LIMIT $4`,
    [conn.user_id, conn.id, PUSHABLE_INVOICE_STATUSES, limit]
  );
  for (const r of invoices) out.push({ kind: "invoice", id: r.id });
  if (settings.push_payments !== false) {
    const payments = await query<{ id: string }>(
      `SELECT p.id FROM invoice_payments p JOIN invoices i ON i.id = p.invoice_id
         LEFT JOIN accounting_links l ON l.connection_id = $2 AND l.entity_kind = 'payment' AND l.entity_id = p.id
        WHERE i.user_id = $1 AND p.status = 'succeeded' AND p.provider <> $3 AND l.id IS NULL
        ORDER BY p.created_at ASC LIMIT $4`,
      [conn.user_id, conn.id, pulledPaymentProvider(conn.provider), limit]
    );
    for (const r of payments) out.push({ kind: "payment", id: r.id });
  }
  if (settings.push_expenses !== false) {
    const expenses = await query<{ id: string }>(
      `SELECT e.id FROM expenses e LEFT JOIN accounting_links l ON l.connection_id = $2 AND l.entity_kind = 'expense' AND l.entity_id = e.id
        WHERE e.user_id = $1 AND l.id IS NULL AND COALESCE(e.ref_kind, '') <> 'bill' ORDER BY e.created_at ASC LIMIT $3`,
      [conn.user_id, conn.id, limit]
    );
    for (const r of expenses) out.push({ kind: "expense", id: r.id });
    const bills = await query<{ id: string }>(
      `SELECT b.id FROM supplier_bills b LEFT JOIN accounting_links l ON l.connection_id = $2 AND l.entity_kind = 'bill' AND l.entity_id = b.id
        WHERE b.user_id = $1 AND b.status = ANY($3::text[]) AND (l.id IS NULL OR (l.error IS NULL AND b.updated_at > COALESCE(l.last_pushed_at, 'epoch'::timestamptz)))
        ORDER BY b.updated_at ASC LIMIT $4`,
      [conn.user_id, conn.id, PUSHABLE_BILL_STATUSES, limit]
    ).catch(() => [] as Array<{ id: string }>);
    for (const r of bills) out.push({ kind: "bill", id: r.id });
  }
  if (settings.push_payments !== false) {
    const billPayments = await query<{ id: string }>(
      `SELECT p.id FROM bill_payments p LEFT JOIN accounting_links l ON l.connection_id = $2 AND l.entity_kind = 'bill_payment' AND l.entity_id = p.id
        WHERE p.user_id = $1 AND l.id IS NULL ORDER BY p.paid_at ASC, p.created_at ASC LIMIT $3`,
      [conn.user_id, conn.id, limit]
    ).catch(() => [] as Array<{ id: string }>);
    for (const r of billPayments) out.push({ kind: "bill_payment", id: r.id });
  }
  return out.slice(0, limit);
}

async function pushDueFor(conn: AccountingConnectionRow, limit: number): Promise<Omit<DueResult, "connections">> {
  const res = { pushed: 0, skipped: 0, errors: 0 };
  const due = await dueForConnection(conn, limit);
  for (const d of due) {
    const out = await pushEntity(conn.id, d.kind, d.id);
    if (out.status === "ok") res.pushed++;
    else if (out.status === "skipped") {
      res.skipped++;
      // Unchanged but newer updated_at: stamp the link so it is not rescanned every tick.
      if (out.remoteId) await upsertLink(conn.user_id, conn.id, d.kind, d.id, { pushed: true });
    } else res.errors++;
    const fresh = await getConnectionById(conn.id);
    if (fresh?.status === "error") break;
  }
  return res;
}

/** Cron: push what changed, across all connected integrations. */
export async function pushDue(limit = 50): Promise<DueResult> {
  const conns = await listAllConnected();
  const total: DueResult = { connections: conns.length, pushed: 0, skipped: 0, errors: 0 };
  for (const c of conns) {
    const r = await pushDueFor(c, limit);
    total.pushed += r.pushed; total.skipped += r.skipped; total.errors += r.errors;
  }
  return total;
}

// ── Pull ─────────────────────────────────────────────────────────────────────

export interface PullResult { connections: number; recorded: number; skipped: number; errors: number }

export async function pullPaymentsFor(conn: AccountingConnectionRow): Promise<Omit<PullResult, "connections">> {
  const res = { recorded: 0, skipped: 0, errors: 0 };
  let s: Session;
  try {
    s = await openSession(conn);
  } catch (err) {
    await markConnectionError(conn.id, errMsg(err), true);
    await logSync(conn.user_id, conn.id, { direction: "pull", status: "error", message: errMsg(err) });
    return { ...res, errors: 1 };
  }
  let pulled;
  try {
    pulled = await s.provider.pullPayments(s.auth, s.ctx, conn.sync_cursor);
  } catch (err) {
    const message = errMsg(err);
    await markConnectionError(conn.id, message, isAuthError(err));
    await logSync(conn.user_id, conn.id, { direction: "pull", kind: "payment", status: "error", message });
    return { ...res, errors: 1 };
  }
  if (pulled.payments.length) {
    const remoteInvoiceIds = [...new Set(pulled.payments.map((p) => p.remoteInvoiceId))];
    const invLinks = await query<{ entity_id: string; remote_id: string }>(
      `SELECT entity_id, remote_id FROM accounting_links WHERE connection_id = $1 AND entity_kind = 'invoice' AND remote_id = ANY($2::text[])`, [conn.id, remoteInvoiceIds]
    );
    const invoiceByRemote = new Map(invLinks.map((l) => [l.remote_id, l.entity_id]));
    const remoteIds = pulled.payments.map((p) => p.remoteId);
    const pushedLinks = await query<{ remote_id: string }>(
      `SELECT remote_id FROM accounting_links WHERE connection_id = $1 AND entity_kind = 'payment' AND remote_id = ANY($2::text[])`, [conn.id, remoteIds]
    );
    const providerName = pulledPaymentProvider(conn.provider);
    const existing = await query<{ provider_ref: string }>(
      `SELECT p.provider_ref FROM invoice_payments p JOIN invoices i ON i.id = p.invoice_id WHERE i.user_id = $1 AND p.provider = $2 AND p.provider_ref = ANY($3::text[])`,
      [conn.user_id, providerName, remoteIds]
    );
    const fresh = selectNewRemotePayments(pulled.payments, new Set(pushedLinks.map((l) => l.remote_id)), new Set(existing.map((e) => e.provider_ref)), invoiceByRemote);
    res.skipped += pulled.payments.length - fresh.length;
    for (const p of fresh) {
      try {
        const inv = await queryOne<{ currency: string }>(`SELECT currency FROM invoices WHERE id = $1`, [p.invoiceId]);
        const r = await recordPayment({ invoiceId: p.invoiceId, provider: providerName, providerRef: p.remoteId, amountMinor: p.amountMinor, currency: p.currency ?? inv?.currency ?? "USD" });
        if (r.duplicate) { res.skipped++; continue; }
        const local = await queryOne<{ id: string }>(`SELECT id FROM invoice_payments WHERE invoice_id = $1 AND provider = $2 AND provider_ref = $3`, [p.invoiceId, providerName, p.remoteId]);
        if (local) await upsertLink(conn.user_id, conn.id, "payment", local.id, { remote_id: p.remoteId, remote_updated_at: p.paidAt, pulled: true, error: null });
        await logSync(conn.user_id, conn.id, { direction: "pull", kind: "payment", entityId: local?.id ?? null, remoteId: p.remoteId, status: "ok", message: `Recorded ${p.amountMinor} ${p.currency ?? ""} on invoice ${p.invoiceId}` });
        res.recorded++;
      } catch (err) {
        res.errors++;
        await logSync(conn.user_id, conn.id, { direction: "pull", kind: "payment", remoteId: p.remoteId, status: "error", message: errMsg(err) });
      }
    }
  }
  await markConnectionSynced(conn.id, pulled.cursor ?? undefined);
  return res;
}

/** Cron: pull payments for the least-recently-synced connections. */
export async function pullDue(limit = 10): Promise<PullResult> {
  const conns = (await listAllConnected(limit)).slice(0, limit);
  const total: PullResult = { connections: conns.length, recorded: 0, skipped: 0, errors: 0 };
  for (const c of conns) {
    const r = await pullPaymentsFor(c);
    total.recorded += r.recorded; total.skipped += r.skipped; total.errors += r.errors;
  }
  return total;
}

/** "Sync now" for one connection: push everything due, then pull payments. */
export async function syncConnection(connectionId: string, limit = 100): Promise<{ push: Omit<DueResult, "connections">; pull: Omit<PullResult, "connections"> }> {
  const conn = await getConnectionById(connectionId);
  if (!conn) throw new Error("Connection not found");
  if (conn.status === "disabled") throw new Error("Connection is disabled");
  const push = await pushDueFor(conn, limit);
  const fresh = (await getConnectionById(connectionId)) ?? conn;
  const pull = fresh.status === "error" ? { recorded: 0, skipped: 0, errors: 0 } : await pullPaymentsFor(fresh);
  return { push, pull };
}

// ── Event-driven auto-push ───────────────────────────────────────────────────

const CURSOR_NAME = "events";
const RELEVANT = new Set(["invoice.sent", "invoice.paid", "expense.created", "supplier_bill.created", "supplier_bill.paid", "product.created"]);

/** Which accounting entity an event refers to. */
export function entityKindForEvent(type: string): AccountingEntityKind | null {
  if (!RELEVANT.has(type)) return null;
  if (type.startsWith("expense.")) return "expense";
  if (type.startsWith("supplier_bill.")) return "bill";
  if (type.startsWith("product.")) return "product";
  return "invoice";
}

export interface AccountingEventRow { id: string; user_id: string; type: string; entity: string; entity_id: string; created_at: string | Date }

/** Called per new event: pushes the entity to every connected integration of that org. */
export async function onAccountingRelevantEvent(evt: Pick<AccountingEventRow, "user_id" | "type" | "entity" | "entity_id">): Promise<PushOutcome[]> {
  const kind = entityKindForEvent(evt.type);
  if (!kind) return [];
  if (evt.type === "supplier_bill.paid") {
    // A paid bill: (re)push the bill, then every payment recorded against it.
    const conns = await listConnectedForUser(evt.user_id);
    const out: PushOutcome[] = [];
    for (const c of conns) out.push(...(await pushBillWithPayments(c.id, evt.entity_id)));
    return out;
  }
  return pushToAll(evt.user_id, kind, evt.entity_id);
}

/** Cron: scan events past our own watermark (same shape as the webhook fan-out). */
export async function processAccountingEvents(limit = 200): Promise<{ scanned: number; pushed: number }> {
  const cur = await queryOne<{ name: string }>(`SELECT name FROM accounting_cursors WHERE name = $1`, [CURSOR_NAME]);
  if (!cur) {
    await query(`INSERT INTO accounting_cursors (name, last_event_at, last_event_id, updated_at) VALUES ($1, NOW(), '', NOW())`, [CURSOR_NAME]).catch(() => undefined);
    return { scanned: 0, pushed: 0 };
  }
  const events = await query<AccountingEventRow>(
    `SELECT e.id, e.user_id, e.type, e.entity, e.entity_id, e.created_at
       FROM events e, accounting_cursors c
      WHERE c.name = $1
        AND (e.created_at > COALESCE(c.last_event_at, 'epoch'::timestamptz)
             OR (e.created_at = c.last_event_at AND e.id > COALESCE(c.last_event_id, '')))
      ORDER BY e.created_at ASC, e.id ASC LIMIT $2`,
    [CURSOR_NAME, Math.min(Math.max(limit, 1), 1000)]
  );
  if (events.length === 0) return { scanned: 0, pushed: 0 };
  let pushed = 0;
  const hasConn = new Map<string, boolean>();
  for (const evt of events) {
    if (!RELEVANT.has(evt.type)) continue;
    let ok = hasConn.get(evt.user_id);
    if (ok === undefined) {
      ok = (await listConnectedForUser(evt.user_id)).length > 0;
      hasConn.set(evt.user_id, ok);
    }
    if (!ok) continue;
    try {
      const outs = await onAccountingRelevantEvent(evt);
      pushed += outs.filter((o) => o.status === "ok").length;
    } catch (err) {
      console.error(`[accounting] auto-push failed for ${evt.type} ${evt.entity_id}:`, err);
    }
  }
  const last = events[events.length - 1];
  await query(
    `UPDATE accounting_cursors SET last_event_at = (SELECT created_at FROM events WHERE id = $2), last_event_id = $2, updated_at = NOW() WHERE name = $1`,
    [CURSOR_NAME, last.id]
  );
  return { scanned: events.length, pushed };
}
