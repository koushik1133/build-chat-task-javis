import { randomUUID } from "crypto";
import { z } from "zod";
import { query, queryOne } from "@/lib/dsql";
import { nextDocNumber } from "@/lib/docs/numbering";
import { emitEvent } from "@/lib/events/bus";
import { enqueueNotification } from "@/lib/notifications/outbox";
import { CurrencySchema, formatMoney } from "@/lib/money/items";
import { businessName } from "@/lib/money/quotes";
import { resolveDocumentTotals } from "@/lib/money/tax-rates";
import { keysetClause, keysetOrder, type Cursor } from "@/lib/public-api/pagination";
import { getSupplier } from "./suppliers";
import { PO_STATUSES, orderedByProduct, receivedByProduct, receiptProgress, type PoStatus, type ReceiptProgress } from "./pure";

/**
 * Purchase orders: what we asked a supplier to deliver. Line items reuse the
 * billing line shape (`unit_minor` is the unit COST). Totals run through the
 * same tax engine as quotes and invoices (catalogue rates or inline bp).
 */

export const PoLineSchema = z.object({
  description: z.string().trim().min(1).max(500),
  qty: z.number().finite().min(0).max(1_000_000),
  /** Unit cost in minor units. */
  unit_minor: z.number().int().min(0).max(1_000_000_000_000),
  tax_rate_bp: z.number().int().min(0).max(10_000).default(0),
  tax_rate_id: z.string().max(100).nullable().optional(),
  tax_rate_ids: z.array(z.string().max(100)).max(5).optional(),
  product_id: z.string().max(100).optional(),
});
export type PoLine = z.infer<typeof PoLineSchema>;
export const PoLinesSchema = z.array(PoLineSchema).max(200);

export function parsePoLines(raw: string | null | undefined): PoLine[] {
  if (!raw) return [];
  try {
    const r = PoLinesSchema.safeParse(JSON.parse(raw));
    return r.success ? r.data : [];
  } catch {
    return [];
  }
}

export interface PurchaseOrderRow {
  id: string;
  user_id: string;
  supplier_id: string;
  number: string;
  status: PoStatus;
  items: string | null;
  subtotal_minor: string | number;
  tax_minor: string | number;
  total_minor: string | number;
  currency: string;
  expected_at: string | null;
  notes: string | null;
  sent_at: string | null;
  received_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

type JoinedRow = PurchaseOrderRow & { supplier_name: string | null; supplier_email: string | null };

export interface PurchaseOrderDTO {
  id: string;
  supplier_id: string;
  supplier_name: string | null;
  supplier_email: string | null;
  number: string;
  status: PoStatus;
  items: PoLine[];
  subtotal_minor: number;
  tax_minor: number;
  total_minor: number;
  currency: string;
  expected_at: string | null;
  notes: string | null;
  sent_at: string | null;
  received_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

const SELECT = `SELECT po.*, s.name AS supplier_name, s.email AS supplier_email FROM purchase_orders po LEFT JOIN suppliers s ON s.id = po.supplier_id`;

function toDTO(r: JoinedRow): PurchaseOrderDTO {
  return {
    id: r.id,
    supplier_id: r.supplier_id,
    supplier_name: r.supplier_name,
    supplier_email: r.supplier_email,
    number: r.number,
    status: r.status,
    items: parsePoLines(r.items),
    subtotal_minor: Number(r.subtotal_minor),
    tax_minor: Number(r.tax_minor),
    total_minor: Number(r.total_minor),
    currency: r.currency,
    expected_at: r.expected_at,
    notes: r.notes,
    sent_at: r.sent_at,
    received_at: r.received_at,
    created_by: r.created_by,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

export const PurchaseOrderInputSchema = z
  .object({
    supplier_id: z.string().min(1).max(100),
    currency: CurrencySchema.optional(),
    items: PoLinesSchema.default([]),
    expected_at: z.string().datetime({ offset: true }).nullable().optional(),
    notes: z.string().trim().max(4000).nullable().optional(),
  })
  .strict();
export type PurchaseOrderInput = z.infer<typeof PurchaseOrderInputSchema>;

export const PurchaseOrderPatchSchema = PurchaseOrderInputSchema.partial().strict();
export type PurchaseOrderPatch = z.infer<typeof PurchaseOrderPatchSchema>;

export interface ListPurchaseOrdersOpts {
  status?: string | null;
  supplierId?: string | null;
  limit?: number;
  cursor?: Cursor | null;
}

export async function listPurchaseOrders(dataId: string, opts: ListPurchaseOrdersOpts = {}): Promise<PurchaseOrderDTO[]> {
  const params: unknown[] = [dataId];
  let sql = `${SELECT} WHERE po.user_id = $1`;
  if (opts.status && (PO_STATUSES as readonly string[]).includes(opts.status)) {
    params.push(opts.status);
    sql += ` AND po.status = $${params.length}`;
  }
  if (opts.supplierId) {
    params.push(opts.supplierId);
    sql += ` AND po.supplier_id = $${params.length}`;
  }
  sql += keysetClause(opts.cursor, params, { alias: "po." });
  params.push(Math.min(Math.max(opts.limit ?? 100, 1), 500));
  sql += ` ORDER BY ${keysetOrder("po.")} LIMIT $${params.length}`;
  return (await query<JoinedRow>(sql, params)).map(toDTO);
}

export async function getPurchaseOrder(dataId: string, id: string): Promise<PurchaseOrderDTO | null> {
  const row = await queryOne<JoinedRow>(`${SELECT} WHERE po.id = $1 AND po.user_id = $2`, [id, dataId]);
  return row ? toDTO(row) : null;
}

export async function createPurchaseOrder(dataId: string, input: PurchaseOrderInput, actorId?: string | null): Promise<PurchaseOrderDTO> {
  const supplier = await getSupplier(dataId, input.supplier_id);
  if (!supplier) throw new Error("Supplier not found");
  const id = randomUUID();
  const [totals, number] = await Promise.all([resolveDocumentTotals(dataId, input.items), nextDocNumber(dataId, "purchase_order")]);
  await query(
    `INSERT INTO purchase_orders (id, user_id, supplier_id, number, status, items, subtotal_minor, tax_minor, total_minor, currency, expected_at, notes, created_by)
     VALUES ($1, $2, $3, $4, 'draft', $5, $6, $7, $8, $9, $10, $11, $12)`,
    [
      id, dataId, supplier.id, number, JSON.stringify(input.items), totals.subtotal_minor, totals.tax_minor, totals.total_minor,
      (input.currency ?? supplier.currency).toUpperCase(), input.expected_at ?? null, input.notes ?? null, actorId ?? null,
    ]
  );
  const po = await getPurchaseOrder(dataId, id);
  if (!po) throw new Error("Purchase order vanished after insert");
  return po;
}

export async function updatePurchaseOrder(dataId: string, id: string, patch: PurchaseOrderPatch): Promise<PurchaseOrderDTO> {
  const po = await getPurchaseOrder(dataId, id);
  if (!po) throw new Error("Purchase order not found");
  if (po.status === "cancelled" || po.status === "received") throw new Error(`Purchase order is ${po.status} and cannot be edited`);
  if (patch.items && po.status !== "draft" && po.status !== "sent") throw new Error("Line items cannot change once receiving has started");
  const sets: string[] = ["updated_at = NOW()"];
  const params: unknown[] = [id, dataId];
  const push = (col: string, v: unknown) => {
    params.push(v);
    sets.push(`${col} = $${params.length}`);
  };
  if (patch.supplier_id !== undefined) {
    if (!(await getSupplier(dataId, patch.supplier_id))) throw new Error("Supplier not found");
    push("supplier_id", patch.supplier_id);
  }
  if (patch.currency !== undefined) push("currency", patch.currency.toUpperCase());
  if (patch.expected_at !== undefined) push("expected_at", patch.expected_at);
  if (patch.notes !== undefined) push("notes", patch.notes);
  if (patch.items) {
    const t = await resolveDocumentTotals(dataId, patch.items);
    push("items", JSON.stringify(patch.items));
    push("subtotal_minor", t.subtotal_minor);
    push("tax_minor", t.tax_minor);
    push("total_minor", t.total_minor);
  }
  await query(`UPDATE purchase_orders SET ${sets.join(", ")} WHERE id = $1 AND user_id = $2`, params);
  const out = await getPurchaseOrder(dataId, id);
  if (!out) throw new Error("Purchase order not found");
  return out;
}

/** Mark sent and email the supplier a summary (no public link: the PDF is available to signed-in users). */
export async function sendPurchaseOrder(
  dataId: string,
  id: string,
  opts: { to?: string | null; message?: string | null } = {}
): Promise<{ purchaseOrder: PurchaseOrderDTO; to: string }> {
  const po = await getPurchaseOrder(dataId, id);
  if (!po) throw new Error("Purchase order not found");
  if (po.status === "cancelled") throw new Error("Purchase order is cancelled");
  if (po.items.length === 0) throw new Error("Add at least one line item before sending");
  const to = (opts.to ?? po.supplier_email ?? "").trim();
  if (!to) throw new Error("No recipient email: set one on the supplier or pass `to`");
  const from = await businessName(dataId);
  await query(
    `UPDATE purchase_orders SET status = CASE WHEN status = 'draft' THEN 'sent' ELSE status END, sent_at = COALESCE(sent_at, NOW()), updated_at = NOW()
      WHERE id = $1 AND user_id = $2`,
    [id, dataId]
  );
  const lines = po.items.map((it) => `  • ${it.description} — ${Number(it.qty)} × ${formatMoney(it.unit_minor, po.currency)}`).join("\n");
  await enqueueNotification(dataId, {
    channel: "email",
    recipient: to,
    subject: `Purchase order ${po.number} from ${from}`,
    body:
      `${opts.message?.trim() ? opts.message.trim() + "\n\n" : ""}` +
      `${from} has placed purchase order ${po.number} for ${formatMoney(po.total_minor, po.currency)}.\n\n` +
      `${lines}\n\n` +
      (po.expected_at ? `Expected by ${new Date(po.expected_at).toDateString()}.\n` : "") +
      (po.notes ? `\n${po.notes}\n` : ""),
    data: { kind: "purchase_order", purchase_order_id: id, number: po.number },
  });
  void emitEvent(dataId, { type: "purchase_order.sent", entity: "purchase_order", entityId: id, data: { number: po.number, to, total_minor: po.total_minor, currency: po.currency, supplier_id: po.supplier_id } });
  const out = await getPurchaseOrder(dataId, id);
  return { purchaseOrder: out ?? po, to };
}

export async function cancelPurchaseOrder(dataId: string, id: string): Promise<PurchaseOrderDTO> {
  const po = await getPurchaseOrder(dataId, id);
  if (!po) throw new Error("Purchase order not found");
  if (po.status === "received" || po.status === "partially_received") throw new Error("Goods were already received against this order; it cannot be cancelled");
  if (po.status === "cancelled") return po;
  await query(`UPDATE purchase_orders SET status = 'cancelled', updated_at = NOW() WHERE id = $1 AND user_id = $2 AND status IN ('draft', 'sent')`, [id, dataId]);
  const out = await getPurchaseOrder(dataId, id);
  return out ?? po;
}

export async function deletePurchaseOrder(dataId: string, id: string): Promise<boolean> {
  const po = await getPurchaseOrder(dataId, id);
  if (!po) return false;
  if (po.status !== "draft") throw new Error("Only draft purchase orders can be deleted; cancel it instead");
  await query(`DELETE FROM purchase_orders WHERE id = $1 AND user_id = $2 AND status = 'draft'`, [id, dataId]);
  return true;
}

// ── receipts ──────────────────────────────────────────────────────────────────

export interface ReceiptRow {
  id: string;
  user_id: string;
  purchase_order_id: string;
  received_at: string;
  lines: string | null;
  note: string | null;
  created_by: string | null;
  created_at: string;
}

export interface ReceiptDTO {
  id: string;
  purchase_order_id: string;
  received_at: string;
  lines: Array<{ product_id: string; qty: number }>;
  note: string | null;
  created_by: string | null;
  created_at: string;
}

export function parseReceiptLines(raw: string | null | undefined): Array<{ product_id: string; qty: number }> {
  if (!raw) return [];
  try {
    const v: unknown = JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    return v
      .filter((x): x is Record<string, unknown> => Boolean(x) && typeof x === "object")
      .map((x) => ({ product_id: String(x.product_id ?? ""), qty: Number(x.qty ?? 0) }))
      .filter((x) => x.product_id && x.qty > 0);
  } catch {
    return [];
  }
}

export function toReceiptDTO(r: ReceiptRow): ReceiptDTO {
  return { id: r.id, purchase_order_id: r.purchase_order_id, received_at: r.received_at, lines: parseReceiptLines(r.lines), note: r.note, created_by: r.created_by, created_at: r.created_at };
}

export async function listReceipts(dataId: string, purchaseOrderId: string): Promise<ReceiptDTO[]> {
  const rows = await query<ReceiptRow>(`SELECT * FROM po_receipts WHERE user_id = $1 AND purchase_order_id = $2 ORDER BY received_at ASC, created_at ASC`, [dataId, purchaseOrderId]);
  return rows.map(toReceiptDTO);
}

/** Ordered vs received per product for a PO. */
export async function purchaseOrderProgress(dataId: string, po: PurchaseOrderDTO): Promise<ReceiptProgress[]> {
  const receipts = await listReceipts(dataId, po.id);
  return receiptProgress(orderedByProduct(po.items), receivedByProduct(receipts.map((r) => r.lines)));
}
