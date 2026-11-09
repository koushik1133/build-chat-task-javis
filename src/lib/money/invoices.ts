import { randomUUID } from "crypto";
import { query, queryOne, withRetry, isUndefinedColumn } from "@/lib/dsql";
import { nextDocNumber } from "@/lib/docs/numbering";
import { issueShareToken } from "@/lib/share-tokens";
import { enqueueNotification } from "@/lib/notifications/outbox";
import { emitEvent } from "@/lib/events/bus";
import { getProvider } from "@/lib/payments";
import type { PaymentEvent } from "@/lib/payments/types";
import { formatMoney, parseItems, type LineItem } from "./items";
import { resolveDocumentTotals } from "./tax-rates";
import { getBillingSettings } from "./settings";
import { parseBreakdown, type TaxBreakdownRow } from "./tax";
import { businessName, getQuote } from "./quotes";
import { consumeForInvoice } from "@/lib/inventory/stock";
import { keysetClause, keysetOrder, type Cursor } from "@/lib/public-api/pagination";

export { computeTotals } from "./items";
export type { LineItem } from "./items";
export type { TaxBreakdownRow } from "./tax";

export type InvoiceStatus = "draft" | "sent" | "partially_paid" | "paid" | "void" | "overdue";

export interface InvoiceRow {
  id: string;
  user_id: string;
  contact_id: string | null;
  quote_id: string | null;
  number: string;
  status: InvoiceStatus;
  currency: string;
  subtotal_minor: string | number;
  tax_minor: string | number;
  total_minor: string | number;
  paid_minor: string | number;
  due_at: string | null;
  items: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
  sent_at: string | null;
  paid_at: string | null;
  tax_breakdown?: string | null;
  terms_days?: number | string | null;
  reminder_count?: number | string | null;
  last_reminder_at?: string | null;
  schedule_id?: string | null;
}

export interface InvoiceDTO {
  id: string;
  contact_id: string | null;
  contact_name: string | null;
  contact_email: string | null;
  quote_id: string | null;
  number: string;
  status: InvoiceStatus;
  currency: string;
  subtotal_minor: number;
  tax_minor: number;
  total_minor: number;
  paid_minor: number;
  due_at: string | null;
  terms_days: number | null;
  reminder_count: number;
  last_reminder_at: string | null;
  schedule_id: string | null;
  items: LineItem[];
  tax_breakdown: TaxBreakdownRow[];
  notes: string | null;
  created_at: string;
  updated_at: string;
  sent_at: string | null;
  paid_at: string | null;
}

export interface PaymentRow {
  id: string;
  invoice_id: string;
  provider: string;
  provider_ref: string | null;
  amount_minor: string | number;
  currency: string;
  status: string;
  created_at: string;
  refunded_minor?: string | number | null;
  refunded_at?: string | null;
  refund_ref?: string | null;
}

type JoinedRow = InvoiceRow & { contact_name: string | null; contact_email: string | null };

const SELECT_JOINED = `
  SELECT i.*, c.full_name AS contact_name, c.email AS contact_email
    FROM invoices i LEFT JOIN crm_contacts c ON c.id = i.contact_id`;

function toDTO(r: JoinedRow): InvoiceDTO {
  return {
    id: r.id,
    contact_id: r.contact_id,
    contact_name: r.contact_name,
    contact_email: r.contact_email,
    quote_id: r.quote_id,
    number: r.number,
    status: r.status,
    currency: r.currency,
    subtotal_minor: Number(r.subtotal_minor),
    tax_minor: Number(r.tax_minor),
    total_minor: Number(r.total_minor),
    paid_minor: Number(r.paid_minor),
    due_at: r.due_at,
    terms_days: r.terms_days === null || r.terms_days === undefined ? null : Number(r.terms_days),
    reminder_count: Number(r.reminder_count ?? 0),
    last_reminder_at: r.last_reminder_at ?? null,
    schedule_id: r.schedule_id ?? null,
    items: parseItems(r.items),
    tax_breakdown: parseBreakdown(r.tax_breakdown),
    notes: r.notes,
    created_at: r.created_at,
    updated_at: r.updated_at,
    sent_at: r.sent_at,
    paid_at: r.paid_at,
  };
}

export async function listInvoices(dataId: string, opts: { status?: string; limit?: number; cursor?: Cursor | null } = {}): Promise<InvoiceDTO[]> {
  const params: unknown[] = [dataId];
  let sql = `${SELECT_JOINED} WHERE i.user_id = $1`;
  if (opts.status) {
    params.push(opts.status);
    sql += ` AND i.status = $${params.length}`;
  }
  sql += keysetClause(opts.cursor, params, { alias: "i." });
  params.push(Math.min(Math.max(opts.limit ?? 100, 1), 500));
  sql += ` ORDER BY ${keysetOrder("i.")} LIMIT $${params.length}`;
  return (await query<JoinedRow>(sql, params)).map(toDTO);
}

export async function getInvoice(dataId: string, id: string): Promise<InvoiceDTO | null> {
  const row = await queryOne<JoinedRow>(`${SELECT_JOINED} WHERE i.id = $1 AND i.user_id = $2`, [id, dataId]);
  return row ? toDTO(row) : null;
}

export async function getInvoiceById(id: string): Promise<InvoiceDTO | null> {
  const row = await queryOne<JoinedRow>(`${SELECT_JOINED} WHERE i.id = $1`, [id]);
  return row ? toDTO(row) : null;
}

export async function listPayments(invoiceId: string): Promise<PaymentRow[]> {
  return query<PaymentRow>(
    `SELECT id, invoice_id, provider, provider_ref, amount_minor, currency, status, created_at, refunded_minor, refunded_at, refund_ref
       FROM invoice_payments WHERE invoice_id = $1 ORDER BY created_at ASC`,
    [invoiceId]
  );
}

export interface CreateInvoiceInput {
  contact_id?: string | null;
  quote_id?: string | null;
  currency?: string;
  items: LineItem[];
  due_at?: string | null;
  /** Payment terms in days; `due_at` is derived from the send date when not given explicitly. */
  terms_days?: number | null;
  notes?: string | null;
  /** Recurring schedule that produced this invoice. */
  schedule_id?: string | null;
}

export async function createInvoice(dataId: string, input: CreateInvoiceInput): Promise<InvoiceDTO> {
  if (input.contact_id) {
    const c = await queryOne(`SELECT id FROM crm_contacts WHERE id = $1 AND user_id = $2`, [input.contact_id, dataId]);
    if (!c) throw new Error("Contact not found");
  }
  const id = randomUUID();
  const [settings, totals] = await Promise.all([getBillingSettings(dataId), resolveDocumentTotals(dataId, input.items)]);
  const number = await nextDocNumber(dataId, "invoice", settings.invoice_prefix);
  const terms = input.terms_days ?? (input.due_at ? null : settings.default_terms_days);
  await query(
    `INSERT INTO invoices (id, user_id, contact_id, quote_id, number, status, currency, subtotal_minor, tax_minor, total_minor,
       paid_minor, due_at, items, notes, tax_breakdown, terms_days, reminder_count, schedule_id)
     VALUES ($1, $2, $3, $4, $5, 'draft', $6, $7, $8, $9, 0, $10, $11, $12, $13, $14, 0, $15)`,
    [
      id, dataId, input.contact_id ?? null, input.quote_id ?? null, number, (input.currency ?? "USD").toUpperCase(),
      totals.subtotal_minor, totals.tax_minor, totals.total_minor,
      input.due_at ?? null, JSON.stringify(input.items), input.notes ?? null,
      JSON.stringify(totals.breakdown), terms, input.schedule_id ?? null,
    ]
  );
  const inv = await getInvoice(dataId, id);
  if (!inv) throw new Error("Invoice vanished after insert");
  void emitEvent(dataId, { type: "invoice.created", entity: "invoice", entityId: id, data: { number, total_minor: totals.total_minor, currency: inv.currency, contact_id: input.contact_id ?? null, quote_id: input.quote_id ?? null } });
  return inv;
}

/** Convert a quote into a draft invoice (idempotent: returns the existing one if already converted). */
export async function createInvoiceFromQuote(dataId: string, quoteId: string, opts: { due_days?: number } = {}): Promise<InvoiceDTO> {
  const existing = await queryOne<JoinedRow>(
    `${SELECT_JOINED} WHERE i.quote_id = $1 AND i.user_id = $2 AND i.status <> 'void' ORDER BY i.created_at DESC LIMIT 1`,
    [quoteId, dataId]
  );
  if (existing) return toDTO(existing);
  const q = await getQuote(dataId, quoteId);
  if (!q) throw new Error("Quote not found");
  if (q.items.length === 0) throw new Error("Quote has no line items");
  // Without explicit `due_days` the invoice carries the org's default payment terms and
  // `due_at` is derived from the send date (sendInvoice), like any other invoice.
  return createInvoice(dataId, {
    contact_id: q.contact_id,
    quote_id: q.id,
    currency: q.currency,
    items: q.items,
    due_at: opts.due_days !== undefined ? new Date(Date.now() + opts.due_days * 86_400_000).toISOString() : null,
    notes: q.notes,
  });
}

export interface UpdateInvoiceInput {
  contact_id?: string | null;
  currency?: string;
  items?: LineItem[];
  due_at?: string | null;
  terms_days?: number | null;
  notes?: string | null;
}

export async function updateInvoice(dataId: string, id: string, input: UpdateInvoiceInput): Promise<InvoiceDTO> {
  const inv = await getInvoice(dataId, id);
  if (!inv) throw new Error("Invoice not found");
  if (inv.status === "void" || inv.status === "paid") throw new Error(`Invoice is ${inv.status} and cannot be edited`);
  if (input.items && inv.paid_minor > 0) throw new Error("Line items cannot change after a payment was recorded");

  const sets: string[] = ["updated_at = NOW()"];
  const params: unknown[] = [id, dataId];
  const push = (col: string, v: unknown) => {
    params.push(v);
    sets.push(`${col} = $${params.length}`);
  };
  if (input.contact_id !== undefined) push("contact_id", input.contact_id);
  if (input.currency !== undefined) push("currency", input.currency.toUpperCase());
  if (input.due_at !== undefined) push("due_at", input.due_at);
  if (input.terms_days !== undefined) push("terms_days", input.terms_days);
  if (input.notes !== undefined) push("notes", input.notes);
  if (input.items) {
    const t = await resolveDocumentTotals(dataId, input.items);
    push("items", JSON.stringify(input.items));
    push("subtotal_minor", t.subtotal_minor);
    push("tax_minor", t.tax_minor);
    push("total_minor", t.total_minor);
    push("tax_breakdown", JSON.stringify(t.breakdown));
  }
  await query(`UPDATE invoices SET ${sets.join(", ")} WHERE id = $1 AND user_id = $2`, params);
  await recomputeInvoiceStatus(id);
  const out = await getInvoice(dataId, id);
  if (!out) throw new Error("Invoice not found");
  return out;
}

/** Derive status from paid vs total and due date. Never touches draft/void. */
export function deriveStatus(inv: { status: InvoiceStatus; total_minor: number; paid_minor: number; due_at: string | null }): InvoiceStatus {
  if (inv.status === "draft" || inv.status === "void") return inv.status;
  if (inv.total_minor > 0 && inv.paid_minor >= inv.total_minor) return "paid";
  if (inv.paid_minor > 0) return "partially_paid";
  if (inv.due_at && new Date(inv.due_at).getTime() < Date.now()) return "overdue";
  return "sent";
}

export async function recomputeInvoiceStatus(id: string): Promise<InvoiceStatus | null> {
  const out = await withRetry(async () => {
    const row = await queryOne<{ user_id: string; status: InvoiceStatus; total_minor: string; due_at: string | null; items: string | null; quote_id: string | null }>(
      `SELECT user_id, status, total_minor, due_at, items, quote_id FROM invoices WHERE id = $1`,
      [id]
    );
    if (!row) return null;
    const sum = await queryOne<{ paid: string | null }>(
      `SELECT SUM(amount_minor - COALESCE(refunded_minor, 0)) AS paid FROM invoice_payments WHERE invoice_id = $1 AND status = 'succeeded'`,
      [id]
    );
    const paid = Number(sum?.paid ?? 0);
    const next = deriveStatus({ status: row.status, total_minor: Number(row.total_minor), paid_minor: paid, due_at: row.due_at });
    await query(
      `UPDATE invoices SET paid_minor = $2, status = $3, paid_at = CASE WHEN $3 = 'paid' THEN COALESCE(paid_at, NOW()) ELSE paid_at END, updated_at = NOW()
        WHERE id = $1`,
      [id, paid, next]
    );
    return { next, row };
  });
  if (!out) return null;
  const { next, row } = out;
  if (next === "paid" && row.status !== "paid") {
    void emitEvent(row.user_id, { type: "invoice.paid", entity: "invoice", entityId: id, data: { total_minor: Number(row.total_minor), quote_id: row.quote_id } });
    // Stock lifecycle: goods leave the shelf once the invoice is paid. Idempotent
    // per invoice inside consumeForInvoice; a failure (insufficient stock, missing
    // table) must never undo or block the payment itself.
    try {
      // Storefront orders linked to this invoice: mark paid, consume against the order
      // reservation, send the confirmation. Dynamic import keeps orders → invoices acyclic.
      const { markOrderPaidForInvoice } = await import("@/lib/storefront/orders");
      await markOrderPaidForInvoice(row.user_id, id);
    } catch (err) {
      console.error(`[invoices] order paid hook failed for ${id}:`, err);
    }
    try {
      await consumeForInvoice(row.user_id, id, parseItems(row.items), { quoteId: row.quote_id });
    } catch (err) {
      console.error(`[invoices] stock consumption failed for ${id}:`, err);
    }
  }
  return next;
}

export async function sendInvoice(
  dataId: string,
  id: string,
  opts: { to?: string | null; message?: string | null } = {}
): Promise<{ invoice: InvoiceDTO; url: string; path: string }> {
  const inv = await getInvoice(dataId, id);
  if (!inv) throw new Error("Invoice not found");
  if (inv.status === "void") throw new Error("Invoice is void");
  if (inv.items.length === 0) throw new Error("Add at least one line item before sending");
  const to = (opts.to ?? inv.contact_email ?? "").trim();
  if (!to) throw new Error("No recipient email: set one on the contact or pass `to`");

  const link = await issueShareToken(dataId, "invoice", id, 90, { recipient: to });
  const from = await businessName(dataId);
  // due_at = sent_at + terms_days when the invoice carries terms and no explicit due date yet.
  await query(
    `UPDATE invoices SET status = CASE WHEN status = 'draft' THEN 'sent' ELSE status END, sent_at = COALESCE(sent_at, NOW()),
            due_at = COALESCE(due_at, CASE WHEN terms_days IS NOT NULL THEN COALESCE(sent_at, NOW()) + make_interval(days => terms_days) END),
            updated_at = NOW()
      WHERE id = $1 AND user_id = $2`,
    [id, dataId]
  );
  await recomputeInvoiceStatus(id);
  // Re-read after the UPDATE: on the first send `due_at` was just derived from the terms.
  const out = await getInvoice(dataId, id);
  const dueAt = out?.due_at ?? inv.due_at;
  await enqueueNotification(dataId, {
    channel: "email",
    recipient: to,
    subject: `Invoice ${inv.number} from ${from}`,
    body:
      `${opts.message?.trim() ? opts.message.trim() + "\n\n" : ""}` +
      `${from} has sent you invoice ${inv.number} for ${formatMoney(inv.total_minor, inv.currency)}.\n\n` +
      `View and pay it here: ${link.url}\n\n` +
      (dueAt ? `Due ${new Date(dueAt).toDateString()}.\n` : ""),
    data: { kind: "invoice", invoice_id: id, number: inv.number, url: link.url },
  });
  void emitEvent(dataId, { type: "invoice.sent", entity: "invoice", entityId: id, data: { number: inv.number, to, total_minor: inv.total_minor, currency: inv.currency } });
  return { invoice: out ?? inv, url: link.url, path: link.path };
}

export async function voidInvoice(dataId: string, id: string): Promise<InvoiceDTO> {
  const inv = await getInvoice(dataId, id);
  if (!inv) throw new Error("Invoice not found");
  if (inv.status === "paid") throw new Error("A paid invoice cannot be voided");
  await query(`UPDATE invoices SET status = 'void', updated_at = NOW() WHERE id = $1 AND user_id = $2`, [id, dataId]);
  const out = await getInvoice(dataId, id);
  return out ?? inv;
}

/**
 * Insert one invoice_payments row. `ref_key` makes the (invoice, provider, ref) uniqueness total —
 * provider_ref when present, else the row id — because DSQL has no partial unique indexes.
 * Falls back to the pre-Phase-10 column list when ref_key has not been migrated yet.
 */
export async function insertPaymentRow(p: {
  invoiceId: string; provider: string; providerRef: string | null;
  amountMinor: number; currency: string; status: string;
}): Promise<void> {
  const id = randomUUID();
  try {
    await query(
      `INSERT INTO invoice_payments (id, invoice_id, provider, provider_ref, ref_key, amount_minor, currency, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [id, p.invoiceId, p.provider, p.providerRef, p.providerRef ?? id, p.amountMinor, p.currency, p.status]
    );
  } catch (err) {
    if (!isUndefinedColumn(err)) throw err;
    await query(
      `INSERT INTO invoice_payments (id, invoice_id, provider, provider_ref, amount_minor, currency, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [id, p.invoiceId, p.provider, p.providerRef, p.amountMinor, p.currency, p.status]
    );
  }
}

/**
 * Record a payment against an invoice and recompute status. Idempotent on
 * (provider, provider_ref) for succeeded payments so replays cannot double-count.
 */
export async function recordPayment(input: {
  invoiceId: string;
  provider: string;
  providerRef: string | null;
  amountMinor: number;
  currency: string;
  status?: "succeeded" | "failed";
}): Promise<{ status: InvoiceStatus | null; duplicate: boolean }> {
  const st = input.status ?? "succeeded";
  if (!Number.isInteger(input.amountMinor) || input.amountMinor < 0) throw new Error("amountMinor must be a non-negative integer");
  const inv = await getInvoiceById(input.invoiceId);
  if (!inv) throw new Error("Invoice not found");
  if (inv.status === "void") throw new Error("Invoice is void");
  if (st === "succeeded" && inv.currency.toUpperCase() !== input.currency.toUpperCase()) {
    throw new Error(`Currency mismatch: invoice ${inv.currency}, payment ${input.currency}`);
  }
  if (input.providerRef) {
    // One row per (invoice, provider, provider_ref) — enforced by uq_invoice_payments_ref_key.
    // A `pending` row written by createPayLink (or an earlier `failed` attempt) is promoted in
    // place; a provider object that already succeeded is never downgraded or double-counted.
    const existing = await queryOne<{ id: string; status: string }>(
      `SELECT id, status FROM invoice_payments WHERE invoice_id = $1 AND provider = $2 AND provider_ref = $3 ORDER BY created_at DESC LIMIT 1`,
      [input.invoiceId, input.provider, input.providerRef]
    );
    if (existing?.status === "succeeded") return { status: inv.status, duplicate: true };
    if (existing) {
      const promoted = await query<{ id: string }>(
        `UPDATE invoice_payments SET status = $2, amount_minor = $3, currency = $4,
                created_at = CASE WHEN $2 = 'succeeded' THEN NOW() ELSE created_at END
          WHERE id = $1 AND status <> 'succeeded' RETURNING id`,
        [existing.id, st, input.amountMinor, input.currency.toUpperCase()]
      );
      // Lost a race with a concurrent success for the same provider object: nothing more to record.
      if (promoted.length === 0) return { status: inv.status, duplicate: true };
      const status = await recomputeInvoiceStatus(input.invoiceId);
      return { status, duplicate: false };
    }
  }
  try {
    await insertPaymentRow({
      invoiceId: input.invoiceId, provider: input.provider, providerRef: input.providerRef,
      amountMinor: input.amountMinor, currency: input.currency.toUpperCase(), status: st,
    });
  } catch (err) {
    // Concurrent first write for the same provider_ref won the unique index: treat as the duplicate it is.
    const code = err && typeof err === "object" && "code" in err ? String((err as { code: unknown }).code) : "";
    const cause = err && typeof err === "object" && "cause" in err ? (err as { cause?: { code?: unknown } }).cause : null;
    if (input.providerRef && (code === "23505" || String(cause?.code ?? "") === "23505")) return { status: inv.status, duplicate: true };
    throw err;
  }
  const status = await recomputeInvoiceStatus(input.invoiceId);
  return { status, duplicate: false };
}

/** Resolve the invoice for a provider event (metadata id first, then a pay token match, then provider_ref). */
export async function findInvoiceForEvent(provider: string, evt: PaymentEvent): Promise<InvoiceDTO | null> {
  if (evt.invoiceId) {
    const inv = await getInvoiceById(evt.invoiceId);
    if (inv) return inv;
  }
  if (evt.providerRef) {
    const p = await queryOne<{ invoice_id: string }>(
      `SELECT invoice_id FROM invoice_payments WHERE provider = $1 AND provider_ref = $2 ORDER BY created_at DESC LIMIT 1`,
      [provider, evt.providerRef]
    );
    if (p) return getInvoiceById(p.invoice_id);
  }
  return null;
}

/**
 * Apply a verified provider event to its invoice. Returns the new status, or
 * null when the event did not map to an invoice (caller decides how to log).
 */
export async function applyPaymentEvent(provider: string, evt: PaymentEvent): Promise<{ invoiceId: string; status: InvoiceStatus | null } | null> {
  const inv = await findInvoiceForEvent(provider, evt);
  if (!inv) return null;
  const res = await recordPayment({
    invoiceId: inv.id,
    provider,
    providerRef: evt.providerRef || null,
    amountMinor: evt.amountMinor,
    currency: evt.currency || inv.currency,
    status: evt.type === "payment.succeeded" ? "succeeded" : "failed",
  });
  return { invoiceId: inv.id, status: res.status };
}

/**
 * Create a checkout with the active provider and a `pay` share token. The
 * token is what the public /p/pay page resolves; the provider reference is
 * stored as a pending payment row so webhooks can map back to the invoice.
 */
export async function createPayLink(dataId: string, id: string): Promise<{ url: string; provider: string; token: string; providerRef: string }> {
  const inv = await getInvoice(dataId, id);
  if (!inv) throw new Error("Invoice not found");
  if (inv.status === "void") throw new Error("Invoice is void");
  if (inv.status === "paid") throw new Error("Invoice is already paid");
  const outstanding = inv.total_minor - inv.paid_minor;
  if (outstanding <= 0) throw new Error("Nothing outstanding on this invoice");

  const provider = getProvider();
  const share = await issueShareToken(dataId, "pay", id, 30);
  const origin = share.url.slice(0, share.url.length - share.path.length);
  const checkout = await provider.createCheckout({
    invoiceId: inv.id,
    amountMinor: outstanding,
    currency: inv.currency,
    description: `Invoice ${inv.number}`,
    successUrl: `${origin}/p/pay/${share.token}?outcome=success`,
    cancelUrl: `${origin}/p/pay/${share.token}?outcome=cancel`,
    token: share.token,
  });
  // Pending row: links provider_ref → invoice for webhook lookup; excluded from paid sums (status 'pending').
  await insertPaymentRow({
    invoiceId: inv.id, provider: provider.id, providerRef: checkout.providerRef,
    amountMinor: outstanding, currency: inv.currency, status: "pending",
  });
  if (inv.status === "draft") {
    await query(`UPDATE invoices SET status = 'sent', sent_at = COALESCE(sent_at, NOW()), updated_at = NOW() WHERE id = $1`, [inv.id]);
  }
  const url = checkout.url.startsWith("/") ? `${origin}${checkout.url}` : checkout.url;
  return { url, provider: provider.id, token: share.token, providerRef: checkout.providerRef };
}
