import { randomUUID } from "crypto";
import { z } from "zod";
import { query, queryOne, withRetry } from "@/lib/dsql";
import { computeTotals, CurrencySchema, LineItemsSchema, parseItems, type LineItem } from "@/lib/money/items";
import { createInvoice, getInvoice, updateInvoice, type InvoiceDTO } from "@/lib/money/invoices";
import { getQuote } from "@/lib/money/quotes";

/**
 * Change orders: scope changes priced as quote-style line items against a
 * quote and/or invoice. Accepting one bills it: items are appended to the
 * linked draft invoice, otherwise a new draft invoice is created.
 */

export const CO_STATUSES = ["draft", "sent", "accepted", "rejected"] as const;
export type ChangeOrderStatus = (typeof CO_STATUSES)[number];

export interface ChangeOrderRow {
  id: string;
  user_id: string;
  quote_id: string | null;
  invoice_id: string | null;
  number: number;
  title: string;
  description: string | null;
  items: string | null;
  delta_minor: string | number;
  currency: string;
  status: ChangeOrderStatus;
  accepted_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ChangeOrderDTO {
  id: string;
  quote_id: string | null;
  invoice_id: string | null;
  number: number;
  label: string;
  title: string;
  description: string | null;
  items: LineItem[];
  delta_minor: number;
  currency: string;
  status: ChangeOrderStatus;
  accepted_at: string | null;
  created_at: string;
  updated_at: string;
}

export function formatCoNumber(n: number): string {
  return `CO-${String(n).padStart(4, "0")}`;
}

export function toChangeOrderDTO(r: ChangeOrderRow): ChangeOrderDTO {
  return {
    id: r.id,
    quote_id: r.quote_id,
    invoice_id: r.invoice_id,
    number: Number(r.number),
    label: formatCoNumber(Number(r.number)),
    title: r.title,
    description: r.description,
    items: parseItems(r.items),
    delta_minor: Number(r.delta_minor),
    currency: r.currency,
    status: r.status,
    accepted_at: r.accepted_at,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

class CounterRace extends Error {
  code = "40001";
  constructor() {
    super("co counter race (OC000)");
  }
}

/** Per-org sequential change-order number (conditional UPDATE + retry, like doc_counters). */
export async function nextChangeOrderNumber(dataId: string): Promise<number> {
  return withRetry(async () => {
    const row = await queryOne<{ next_number: number | string }>(`SELECT next_number FROM co_counters WHERE user_id = $1`, [dataId]);
    if (!row) {
      const inserted = await query<{ user_id: string }>(
        `INSERT INTO co_counters (user_id, next_number) VALUES ($1, 2) ON CONFLICT (user_id) DO NOTHING RETURNING user_id`,
        [dataId]
      );
      if (inserted.length === 0) throw new CounterRace();
      return 1;
    }
    const old = Number(row.next_number);
    const updated = await query<{ user_id: string }>(
      `UPDATE co_counters SET next_number = $2 WHERE user_id = $1 AND next_number = $3 RETURNING user_id`,
      [dataId, old + 1, old]
    );
    if (updated.length === 0) throw new CounterRace();
    return old;
  }, 6);
}

export const ChangeOrderInputSchema = z
  .object({
    quote_id: z.string().max(100).nullable().optional(),
    invoice_id: z.string().max(100).nullable().optional(),
    title: z.string().trim().min(1).max(200),
    description: z.string().trim().max(4000).nullable().optional(),
    items: LineItemsSchema.default([]),
    currency: CurrencySchema.optional(),
  })
  .strict();
export type ChangeOrderInput = z.infer<typeof ChangeOrderInputSchema>;

export const ChangeOrderPatchSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    description: z.string().trim().max(4000).nullable().optional(),
    items: LineItemsSchema.optional(),
    currency: CurrencySchema.optional(),
    quote_id: z.string().max(100).nullable().optional(),
    invoice_id: z.string().max(100).nullable().optional(),
    status: z.enum(CO_STATUSES).optional(),
  })
  .strict();
export type ChangeOrderPatch = z.infer<typeof ChangeOrderPatchSchema>;

export async function listChangeOrders(dataId: string, opts: { quoteId?: string | null; invoiceId?: string | null; status?: string | null; limit?: number } = {}): Promise<ChangeOrderDTO[]> {
  const params: unknown[] = [dataId];
  let sql = `SELECT * FROM change_orders WHERE user_id = $1`;
  if (opts.quoteId) {
    params.push(opts.quoteId);
    sql += ` AND quote_id = $${params.length}`;
  }
  if (opts.invoiceId) {
    params.push(opts.invoiceId);
    sql += ` AND invoice_id = $${params.length}`;
  }
  if (opts.status) {
    params.push(opts.status);
    sql += ` AND status = $${params.length}`;
  }
  params.push(Math.min(Math.max(opts.limit ?? 200, 1), 500));
  sql += ` ORDER BY number DESC LIMIT $${params.length}`;
  return (await query<ChangeOrderRow>(sql, params)).map(toChangeOrderDTO);
}

export async function getChangeOrder(dataId: string, id: string): Promise<ChangeOrderDTO | null> {
  const row = await queryOne<ChangeOrderRow>(`SELECT * FROM change_orders WHERE id = $1 AND user_id = $2`, [id, dataId]);
  return row ? toChangeOrderDTO(row) : null;
}

async function resolveLinks(dataId: string, quoteId: string | null | undefined, invoiceId: string | null | undefined) {
  const quote = quoteId ? await getQuote(dataId, quoteId) : null;
  if (quoteId && !quote) throw new Error("Quote not found");
  const invoice = invoiceId ? await getInvoice(dataId, invoiceId) : null;
  if (invoiceId && !invoice) throw new Error("Invoice not found");
  return { quote, invoice };
}

export async function createChangeOrder(dataId: string, input: ChangeOrderInput): Promise<ChangeOrderDTO> {
  const { quote, invoice } = await resolveLinks(dataId, input.quote_id, input.invoice_id);
  const currency = (input.currency ?? invoice?.currency ?? quote?.currency ?? "USD").toUpperCase();
  const totals = computeTotals(input.items);
  const id = randomUUID();
  const number = await nextChangeOrderNumber(dataId);
  await query(
    `INSERT INTO change_orders (id, user_id, quote_id, invoice_id, number, title, description, items, delta_minor, currency, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'draft')`,
    [id, dataId, quote?.id ?? null, invoice?.id ?? null, number, input.title, input.description ?? null, JSON.stringify(input.items), totals.total_minor, currency]
  );
  const co = await getChangeOrder(dataId, id);
  if (!co) throw new Error("Change order vanished after insert");
  return co;
}

const TRANSITIONS: Record<ChangeOrderStatus, ChangeOrderStatus[]> = {
  draft: ["sent", "accepted", "rejected"],
  sent: ["accepted", "rejected", "draft"],
  accepted: [],
  rejected: ["draft"],
};

export interface UpdateChangeOrderResult {
  change_order: ChangeOrderDTO;
  /** Set when the status moved to accepted and billing happened. */
  invoice?: InvoiceDTO;
}

/**
 * Patch fields and/or move status. Accepted change orders are frozen. Moving to
 * `accepted` bills the items: appended to the linked draft invoice, otherwise a
 * new draft invoice is created (linked to the quote's contact when present).
 */
export async function updateChangeOrder(dataId: string, id: string, patch: ChangeOrderPatch): Promise<UpdateChangeOrderResult> {
  const co = await getChangeOrder(dataId, id);
  if (!co) throw new Error("Change order not found");
  if (co.status === "accepted") throw new Error("Accepted change orders cannot be edited");

  const sets: string[] = ["updated_at = NOW()"];
  const params: unknown[] = [id, dataId];
  const push = (col: string, v: unknown) => {
    params.push(v);
    sets.push(`${col} = $${params.length}`);
  };
  if (patch.quote_id !== undefined || patch.invoice_id !== undefined) {
    // `undefined` keeps the current link; an explicit `null` clears it.
    const { quote, invoice } = await resolveLinks(
      dataId,
      patch.quote_id === undefined ? co.quote_id : patch.quote_id,
      patch.invoice_id === undefined ? co.invoice_id : patch.invoice_id
    );
    if (patch.quote_id !== undefined) push("quote_id", quote?.id ?? null);
    if (patch.invoice_id !== undefined) push("invoice_id", invoice?.id ?? null);
  }
  if (patch.title !== undefined) push("title", patch.title);
  if (patch.description !== undefined) push("description", patch.description);
  if (patch.currency !== undefined) push("currency", patch.currency);
  if (patch.items !== undefined) {
    push("items", JSON.stringify(patch.items));
    push("delta_minor", computeTotals(patch.items).total_minor);
  }
  if (patch.status !== undefined && patch.status !== co.status) {
    if (!TRANSITIONS[co.status].includes(patch.status)) throw new Error(`Cannot move a ${co.status} change order to ${patch.status}`);
    push("status", patch.status);
    if (patch.status === "accepted") push("accepted_at", new Date().toISOString());
  }
  await query(`UPDATE change_orders SET ${sets.join(", ")} WHERE id = $1 AND user_id = $2`, params);

  let invoice: InvoiceDTO | undefined;
  if (patch.status === "accepted") {
    try {
      invoice = await billChangeOrder(dataId, id);
    } catch (err) {
      // Roll the status back so the user can fix the invoice and retry.
      await query(`UPDATE change_orders SET status = $3, accepted_at = NULL, updated_at = NOW() WHERE id = $1 AND user_id = $2`, [id, dataId, co.status]).catch(() => undefined);
      throw err;
    }
  }
  const out = await getChangeOrder(dataId, id);
  if (!out) throw new Error("Change order not found");
  return invoice ? { change_order: out, invoice } : { change_order: out };
}

/** Append the change order's items to its draft invoice or create a new invoice. */
async function billChangeOrder(dataId: string, id: string): Promise<InvoiceDTO> {
  const co = await getChangeOrder(dataId, id);
  if (!co) throw new Error("Change order not found");
  if (co.items.length === 0) throw new Error("Add at least one line item before accepting");
  const items: LineItem[] = co.items.map((it) => ({ ...it, description: `${co.label}: ${it.description}` }));

  const linked = co.invoice_id ? await getInvoice(dataId, co.invoice_id) : null;
  if (linked && linked.status === "draft") {
    if (linked.currency.toUpperCase() !== co.currency.toUpperCase()) throw new Error(`Currency mismatch: invoice ${linked.currency}, change order ${co.currency}`);
    return updateInvoice(dataId, linked.id, { items: [...linked.items, ...items] });
  }
  const quote = co.quote_id ? await getQuote(dataId, co.quote_id) : null;
  const inv = await createInvoice(dataId, {
    contact_id: linked?.contact_id ?? quote?.contact_id ?? null,
    quote_id: quote?.id ?? null,
    currency: co.currency,
    items,
    due_at: new Date(Date.now() + 14 * 86_400_000).toISOString(),
    notes: `Change order ${co.label}: ${co.title}`,
  });
  await query(`UPDATE change_orders SET invoice_id = $3, updated_at = NOW() WHERE id = $1 AND user_id = $2`, [id, dataId, inv.id]);
  return inv;
}

export async function deleteChangeOrder(dataId: string, id: string): Promise<boolean> {
  const co = await getChangeOrder(dataId, id);
  if (!co) return false;
  if (co.status === "accepted") throw new Error("Accepted change orders cannot be deleted");
  await query(`DELETE FROM change_orders WHERE id = $1 AND user_id = $2`, [id, dataId]);
  return true;
}
