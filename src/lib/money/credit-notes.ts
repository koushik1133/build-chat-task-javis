import { randomUUID } from "crypto";
import { z } from "zod";
import { query, queryOne } from "@/lib/dsql";
import { tableExists } from "@/lib/table-exists";
import { nextDocNumber } from "@/lib/docs/numbering";
import { emitEvent } from "@/lib/events/bus";
import { getProvider } from "@/lib/payments";
import { CurrencySchema, LineItemsSchema, parseItems, type LineItem } from "./items";
import { parseBreakdown, type TaxBreakdownRow } from "./tax";
import { resolveDocumentTotals } from "./tax-rates";
import { getBillingSettings } from "./settings";
import { getInvoice, listPayments, recomputeInvoiceStatus, type PaymentRow } from "./invoices";
import { keysetClause, keysetOrder, type Cursor } from "@/lib/public-api/pagination";

/**
 * Credit notes (negative documents against an invoice or a contact) and
 * refunds of recorded payments through the active payment provider.
 *
 * A credit note is drafted, then issued. Issuing against an invoice marks it
 * `applied` (it reduces the customer's balance on statements); a later refund
 * that references the note marks it `refunded`.
 */

export type CreditNoteStatus = "draft" | "issued" | "applied" | "refunded";

export interface CreditNoteDTO {
  id: string;
  invoice_id: string | null;
  invoice_number: string | null;
  contact_id: string | null;
  contact_name: string | null;
  contact_email: string | null;
  number: string;
  items: LineItem[];
  subtotal_minor: number;
  tax_minor: number;
  total_minor: number;
  tax_breakdown: TaxBreakdownRow[];
  currency: string;
  reason: string | null;
  status: CreditNoteStatus;
  issued_at: string | null;
  created_at: string;
  updated_at: string;
}

interface Row {
  id: string;
  invoice_id: string | null;
  invoice_number: string | null;
  contact_id: string | null;
  contact_name: string | null;
  contact_email: string | null;
  number: string;
  items: string | null;
  subtotal_minor: string | number;
  tax_minor: string | number;
  total_minor: string | number;
  tax_breakdown: string | null;
  currency: string;
  reason: string | null;
  status: CreditNoteStatus;
  issued_at: string | Date | null;
  created_at: string | Date;
  updated_at: string | Date;
}

const iso = (v: string | Date): string => (v instanceof Date ? v.toISOString() : String(v));

function toDTO(r: Row): CreditNoteDTO {
  return {
    id: r.id,
    invoice_id: r.invoice_id,
    invoice_number: r.invoice_number,
    contact_id: r.contact_id,
    contact_name: r.contact_name,
    contact_email: r.contact_email,
    number: r.number,
    items: parseItems(r.items),
    subtotal_minor: Number(r.subtotal_minor),
    tax_minor: Number(r.tax_minor),
    total_minor: Number(r.total_minor),
    tax_breakdown: parseBreakdown(r.tax_breakdown),
    currency: r.currency,
    reason: r.reason,
    status: r.status,
    issued_at: r.issued_at ? iso(r.issued_at) : null,
    created_at: iso(r.created_at),
    updated_at: iso(r.updated_at),
  };
}

const SELECT = `
  SELECT n.*, i.number AS invoice_number, c.full_name AS contact_name, c.email AS contact_email
    FROM credit_notes n
    LEFT JOIN invoices i ON i.id = n.invoice_id
    LEFT JOIN crm_contacts c ON c.id = n.contact_id`;

export const CreditNoteInputSchema = z
  .object({
    invoice_id: z.string().max(100).nullable().optional(),
    contact_id: z.string().max(100).nullable().optional(),
    /** Omit to credit the full invoice (its line items are copied). */
    items: LineItemsSchema.min(1).optional(),
    currency: CurrencySchema.optional(),
    reason: z.string().trim().max(2000).nullable().optional(),
    /** Issue immediately instead of leaving a draft. */
    issue: z.boolean().optional(),
  })
  .strict();
export type CreditNoteInput = z.infer<typeof CreditNoteInputSchema>;

export async function listCreditNotes(dataId: string, opts: { status?: string; invoice_id?: string; contact_id?: string; limit?: number; cursor?: Cursor | null } = {}): Promise<CreditNoteDTO[]> {
  if (!(await tableExists("credit_notes"))) return [];
  const params: unknown[] = [dataId];
  let sql = `${SELECT} WHERE n.user_id = $1`;
  if (opts.status) {
    params.push(opts.status);
    sql += ` AND n.status = $${params.length}`;
  }
  if (opts.invoice_id) {
    params.push(opts.invoice_id);
    sql += ` AND n.invoice_id = $${params.length}`;
  }
  if (opts.contact_id) {
    params.push(opts.contact_id);
    sql += ` AND n.contact_id = $${params.length}`;
  }
  sql += keysetClause(opts.cursor, params, { alias: "n." });
  params.push(Math.min(Math.max(opts.limit ?? 100, 1), 500));
  sql += ` ORDER BY ${keysetOrder("n.")} LIMIT $${params.length}`;
  return (await query<Row>(sql, params)).map(toDTO);
}

export async function getCreditNote(dataId: string, id: string): Promise<CreditNoteDTO | null> {
  const row = await queryOne<Row>(`${SELECT} WHERE n.id = $1 AND n.user_id = $2`, [id, dataId]);
  return row ? toDTO(row) : null;
}

/** Sum of non-draft credit notes already recorded against an invoice (minor units). */
async function creditedAgainstInvoice(dataId: string, invoiceId: string, excludeId: string | null = null): Promise<number> {
  const prior = await queryOne<{ total: string | null }>(
    `SELECT SUM(total_minor) AS total FROM credit_notes WHERE invoice_id = $1 AND user_id = $2 AND status <> 'draft' AND ($3::text IS NULL OR id <> $3)`,
    [invoiceId, dataId, excludeId]
  );
  return Number(prior?.total ?? 0);
}

export async function createCreditNote(dataId: string, input: CreditNoteInput): Promise<CreditNoteDTO> {
  let items = input.items ?? null;
  let contactId = input.contact_id ?? null;
  let currency = input.currency?.toUpperCase() ?? null;
  // A caller-supplied contact must belong to this org, whether or not an invoice is referenced.
  if (contactId) {
    const c = await queryOne(`SELECT id FROM crm_contacts WHERE id = $1 AND user_id = $2`, [contactId, dataId]);
    if (!c) throw new Error("Contact not found");
  }
  let inv: Awaited<ReturnType<typeof getInvoice>> = null;
  if (input.invoice_id) {
    inv = await getInvoice(dataId, input.invoice_id);
    if (!inv) throw new Error("Invoice not found");
    if (inv.status === "draft") throw new Error("Issue the invoice before crediting it");
    if (!items) items = inv.items;
    contactId = contactId ?? inv.contact_id;
    // The cap below compares minor units, which only means something in the invoice's currency.
    if (currency && currency !== inv.currency.toUpperCase()) throw new Error(`Credit note currency ${currency} does not match invoice currency ${inv.currency}`);
    currency = currency ?? inv.currency;
  }
  if (!items || items.length === 0) throw new Error("Add at least one line item or reference an invoice");

  const [settings, totals] = await Promise.all([getBillingSettings(dataId), resolveDocumentTotals(dataId, items)]);
  if (inv) {
    // Credits against an invoice can never exceed what was invoiced.
    const prior = await creditedAgainstInvoice(dataId, inv.id);
    if (prior + totals.total_minor > inv.total_minor) throw new Error("Credit exceeds the invoice total");
  }
  const number = await nextDocNumber(dataId, "credit_note", settings.credit_note_prefix);
  const id = randomUUID();
  await query(
    `INSERT INTO credit_notes (id, user_id, invoice_id, contact_id, number, items, subtotal_minor, tax_minor, total_minor, tax_breakdown, currency, reason, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'draft')`,
    [id, dataId, input.invoice_id ?? null, contactId, number, JSON.stringify(items), totals.subtotal_minor, totals.tax_minor, totals.total_minor, JSON.stringify(totals.breakdown), currency ?? "USD", input.reason ?? null]
  );
  if (input.issue) return issueCreditNote(dataId, id);
  const out = await getCreditNote(dataId, id);
  if (!out) throw new Error("Credit note vanished after insert");
  return out;
}

export async function issueCreditNote(dataId: string, id: string): Promise<CreditNoteDTO> {
  const cn = await getCreditNote(dataId, id);
  if (!cn) throw new Error("Credit note not found");
  if (cn.status !== "draft") throw new Error(`Credit note is already ${cn.status}`);
  if (cn.invoice_id) {
    // Re-check the cap at issue time: several drafts can each pass the create-time check.
    const inv = await getInvoice(dataId, cn.invoice_id);
    if (!inv) throw new Error("Invoice not found");
    const prior = await creditedAgainstInvoice(dataId, inv.id, cn.id);
    if (prior + cn.total_minor > inv.total_minor) throw new Error("Credit exceeds the invoice total");
  }
  const next: CreditNoteStatus = cn.invoice_id ? "applied" : "issued";
  const flipped = await query<{ id: string }>(
    `UPDATE credit_notes SET status = $3, issued_at = NOW(), updated_at = NOW() WHERE id = $1 AND user_id = $2 AND status = 'draft' RETURNING id`,
    [id, dataId, next]
  );
  if (flipped.length === 0) throw new Error("Credit note was already issued");
  const out = await getCreditNote(dataId, id);
  await emitEvent(dataId, {
    type: "credit_note.issued",
    entity: "credit_note",
    entityId: id,
    data: { number: cn.number, invoice_id: cn.invoice_id, contact_id: cn.contact_id, total_minor: cn.total_minor, currency: cn.currency, status: next, reason: cn.reason },
  });
  return out ?? { ...cn, status: next, issued_at: new Date().toISOString() };
}

export async function deleteDraftCreditNote(dataId: string, id: string): Promise<boolean> {
  const cn = await getCreditNote(dataId, id);
  if (!cn) return false;
  if (cn.status !== "draft") throw new Error("Only draft credit notes can be deleted");
  await query(`DELETE FROM credit_notes WHERE id = $1 AND user_id = $2`, [id, dataId]);
  return true;
}

/* ─── refunds ──────────────────────────────────────────────────────────── */

export const RefundBodySchema = z
  .object({
    paymentId: z.string().min(1).max(100),
    amount_minor: z.number().int().positive().max(1_000_000_000_000),
    credit_note_id: z.string().max(100).nullable().optional(),
    reason: z.string().trim().max(500).nullable().optional(),
  })
  .strict();
export type RefundBody = z.infer<typeof RefundBodySchema>;

export interface RefundOutcome {
  payment: PaymentRow;
  refund_ref: string;
  invoice_status: string | null;
}

/**
 * Refund part or all of a succeeded payment. The provider that took the
 * payment performs the refund (the simulated provider always succeeds);
 * the payment row keeps a cumulative `refunded_minor` and the invoice status
 * is recomputed from net receipts.
 */
export async function refundPayment(dataId: string, invoiceId: string, body: RefundBody): Promise<RefundOutcome> {
  const inv = await getInvoice(dataId, invoiceId);
  if (!inv) throw new Error("Invoice not found");
  const payments = await listPayments(invoiceId);
  const p = payments.find((x) => x.id === body.paymentId);
  if (!p) throw new Error("Payment not found");
  if (p.status !== "succeeded") throw new Error("Only succeeded payments can be refunded");
  const already = Number(p.refunded_minor ?? 0);
  const refundable = Number(p.amount_minor) - already;
  if (body.amount_minor > refundable) throw new Error(`Refund exceeds the refundable amount (${refundable} minor units)`);

  let cn: CreditNoteDTO | null = null;
  if (body.credit_note_id) {
    cn = await getCreditNote(dataId, body.credit_note_id);
    if (!cn) throw new Error("Credit note not found");
    if (cn.status === "draft") throw new Error("Issue the credit note before refunding it");
    if (cn.status === "refunded") throw new Error("Credit note was already refunded");
    if (cn.invoice_id && cn.invoice_id !== invoiceId) throw new Error("Credit note belongs to a different invoice");
    if (body.amount_minor > cn.total_minor) throw new Error(`Refund exceeds the credit note total (${cn.total_minor} minor units)`);
  }

  const provider = getProvider(p.provider === "manual" ? "simulated" : p.provider);

  // Claim the amount on the payment row *before* money moves: the conditional UPDATE on the
  // previous refunded total means two concurrent refunds can never both reach the provider.
  const claimed = await query<{ id: string }>(
    `UPDATE invoice_payments SET refunded_minor = COALESCE(refunded_minor, 0) + $2, refunded_at = NOW()
      WHERE id = $1 AND COALESCE(refunded_minor, 0) = $3 RETURNING id`,
    [p.id, body.amount_minor, already]
  );
  if (claimed.length === 0) throw new Error("Payment changed while refunding; reload and try again");

  let result: Awaited<ReturnType<typeof provider.refund>>;
  try {
    result = await provider.refund({ providerRef: p.provider_ref ?? p.id, amountMinor: body.amount_minor, currency: p.currency, invoiceId, reason: body.reason ?? null });
  } catch (err) {
    // Provider refused: release the claim (only our own increment) so the amount stays refundable.
    await query(
      `UPDATE invoice_payments SET refunded_minor = COALESCE(refunded_minor, 0) - $2, refunded_at = CASE WHEN COALESCE(refunded_minor, 0) - $2 > 0 THEN refunded_at ELSE NULL END
        WHERE id = $1 AND COALESCE(refunded_minor, 0) = $3`,
      [p.id, body.amount_minor, already + body.amount_minor]
    ).catch((e) => console.error(`[credit-notes] could not release refund claim on payment ${p.id}:`, e));
    throw err;
  }
  await query(`UPDATE invoice_payments SET refund_ref = $2 WHERE id = $1`, [p.id, result.refundRef]);
  if (cn) await query(`UPDATE credit_notes SET status = 'refunded', updated_at = NOW() WHERE id = $1 AND user_id = $2`, [cn.id, dataId]);
  const status = await recomputeInvoiceStatus(invoiceId);
  await emitEvent(dataId, {
    type: "payment.refunded",
    entity: "invoice",
    entityId: invoiceId,
    data: { payment_id: p.id, provider: p.provider, refund_ref: result.refundRef, amount_minor: body.amount_minor, currency: p.currency, credit_note_id: cn?.id ?? null, number: inv.number, reason: body.reason ?? null },
  });
  const fresh = (await listPayments(invoiceId)).find((x) => x.id === p.id) ?? p;
  return { payment: fresh, refund_ref: result.refundRef, invoice_status: status };
}
