import { randomUUID } from "crypto";
import { z } from "zod";
import { query, queryOne, withRetry } from "@/lib/dsql";
import { emitEvent } from "@/lib/events/bus";
import { adjustStock } from "@/lib/inventory/stock";
import { getProductsByIds } from "@/lib/inventory/products";
import { getPurchaseOrder, listReceipts, type PurchaseOrderDTO, type ReceiptDTO, toReceiptDTO, type ReceiptRow } from "./purchase-orders";
import { orderedByProduct, overReceipts, receiptProgress, receiveStatus, receivedByProduct, weightedAverageCost } from "./pure";

/**
 * Goods receipt against a purchase order.
 *
 *   1. validate lines against what is still outstanding on the PO
 *   2. one `receive` stock movement per line (ref_kind purchase_order) via adjustStock
 *   3. re-cost the product: weighted average of what was on hand and what just arrived,
 *      applied with a conditional UPDATE (cost/on-hand unchanged since we read them) inside withRetry
 *   4. append the receipt row, recompute received-vs-ordered and move the PO status
 */

export const ReceiveLinesSchema = z
  .object({
    lines: z.array(z.object({ product_id: z.string().min(1).max(100), qty: z.number().int().min(1).max(1_000_000) }).strict()).min(1).max(200),
    note: z.string().trim().max(1000).nullable().optional(),
    received_at: z.string().datetime({ offset: true }).optional(),
  })
  .strict();
export type ReceiveLinesInput = z.infer<typeof ReceiveLinesSchema>;

export class OverReceiptError extends Error {
  readonly code = "OVER_RECEIPT";
  constructor(public readonly details: Array<{ product_id: string; requested: number; remaining: number }>) {
    super(`Receipt exceeds what is outstanding on the order: ${details.map((d) => `${d.product_id} (requested ${d.requested}, remaining ${d.remaining})`).join("; ")}`);
    this.name = "OverReceiptError";
  }
}

class CostRace extends Error {
  code = "40001";
  constructor() {
    super("product cost race (OC000)");
  }
}

/** Weighted-average re-cost after `qty` units arrived at `unitCost`. Race-safe via conditional UPDATE. */
export async function recostProduct(dataId: string, productId: string, qty: number, unitCost: number): Promise<number | null> {
  return withRetry(async () => {
    const p = await queryOne<{ stock_on_hand: number | string; cost_minor: number | string }>(
      `SELECT stock_on_hand, cost_minor FROM products WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
      [productId, dataId]
    );
    if (!p) return null;
    const onHand = Number(p.stock_on_hand);
    const oldCost = Number(p.cost_minor);
    // The receive movement has already landed, so on-hand-before = on-hand-now − qty.
    const next = weightedAverageCost(onHand - qty, oldCost, qty, unitCost);
    const rows = await query<{ id: string }>(
      `UPDATE products SET cost_minor = $3, last_cost_minor = $4, updated_at = NOW()
        WHERE id = $1 AND user_id = $2 AND stock_on_hand = $5 AND cost_minor = $6 RETURNING id`,
      [productId, dataId, next, unitCost, onHand, oldCost]
    );
    if (rows.length === 0) throw new CostRace();
    return next;
  }, 6);
}

export interface ReceiveResult {
  purchaseOrder: PurchaseOrderDTO;
  receipt: ReceiptDTO;
  /** Products whose cost changed: id → new weighted average cost. */
  recosted: Record<string, number>;
}

export async function receivePurchaseOrder(dataId: string, poId: string, input: ReceiveLinesInput, actorId?: string | null): Promise<ReceiveResult> {
  const po = await getPurchaseOrder(dataId, poId);
  if (!po) throw new Error("Purchase order not found");
  if (po.status === "cancelled") throw new Error("Purchase order is cancelled");
  if (po.status === "received") throw new Error("Purchase order is already fully received");
  if (po.status === "draft") throw new Error("Send the purchase order before receiving against it");

  const ordered = orderedByProduct(po.items);
  if (ordered.size === 0) throw new Error("This purchase order has no lines linked to products, so nothing can be received into stock");
  const prior = await listReceipts(dataId, po.id);
  const received = receivedByProduct(prior.map((r) => r.lines));
  for (const l of input.lines) if (!ordered.has(l.product_id)) throw new Error(`Product ${l.product_id} is not on this purchase order`);
  const over = overReceipts(input.lines, ordered, received);
  if (over.length > 0) throw new OverReceiptError(over);

  // Unit cost per product from the PO lines (first matching line wins; qty-weighted when several).
  const costByProduct = new Map<string, number>();
  for (const it of po.items) {
    if (!it.product_id || costByProduct.has(it.product_id)) continue;
    costByProduct.set(it.product_id, it.unit_minor);
  }
  const products = await getProductsByIds(dataId, input.lines.map((l) => l.product_id));

  const recosted: Record<string, number> = {};
  for (const l of input.lines) {
    if (!products.has(l.product_id)) throw new Error(`Product ${l.product_id} no longer exists`);
    await adjustStock(dataId, l.product_id, { kind: "receive", qty: l.qty, ref_kind: "purchase_order", ref_id: po.id, note: `Received on ${po.number}` }, actorId ?? null);
    const unitCost = costByProduct.get(l.product_id) ?? 0;
    const next = await recostProduct(dataId, l.product_id, l.qty, unitCost);
    if (next !== null) recosted[l.product_id] = next;
  }

  const receiptId = randomUUID();
  await query(
    `INSERT INTO po_receipts (id, user_id, purchase_order_id, received_at, lines, note, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [receiptId, dataId, po.id, input.received_at ?? new Date().toISOString(), JSON.stringify(input.lines), input.note ?? null, actorId ?? null]
  );

  const all = await listReceipts(dataId, po.id);
  const progress = receiptProgress(ordered, receivedByProduct(all.map((r) => r.lines)));
  const status = receiveStatus(progress) ?? "partially_received";
  await query(
    `UPDATE purchase_orders SET status = $3, received_at = CASE WHEN $3 = 'received' THEN COALESCE(received_at, NOW()) ELSE received_at END, updated_at = NOW()
      WHERE id = $1 AND user_id = $2 AND status NOT IN ('cancelled')`,
    [po.id, dataId, status]
  );
  void emitEvent(dataId, {
    type: "purchase_order.received",
    entity: "purchase_order",
    entityId: po.id,
    data: { number: po.number, status, receipt_id: receiptId, lines: input.lines, complete: status === "received", supplier_id: po.supplier_id },
  });
  const out = await getPurchaseOrder(dataId, po.id);
  const receipt = await queryOne<ReceiptRow>(`SELECT * FROM po_receipts WHERE id = $1`, [receiptId]);
  if (!receipt) throw new Error("Receipt vanished after insert");
  return { purchaseOrder: out ?? po, receipt: toReceiptDTO(receipt), recosted };
}
