import { randomUUID } from "crypto";
import { query, queryOne, withRetry } from "@/lib/dsql";
import type { LineItem } from "@/lib/money/items";
import { getProduct, getProductsByIds, type ProductDTO } from "./products";

/**
 * Stock ledger. Every change to `products.stock_on_hand` / `stock_reserved`
 * goes through a conditional UPDATE (`WHERE stock_on_hand - stock_reserved >= qty`)
 * inside `withRetry`, so two concurrent reservations can never over-promise:
 * the UPDATE either applies atomically or returns zero rows.
 *
 *   reserve  — quote accepted: reserved += qty       (available shrinks)
 *   release  — quote cancelled/voided: reserved -= qty
 *   consume  — invoice billed: on_hand -= qty, and any matching reservation is cleared
 *   receive  — stock in: on_hand += qty
 *   adjust   — manual count correction: on_hand += qty (qty may be negative)
 *   checkout — equipment out on a job: reserved += qty
 *   checkin  — equipment returned: reserved -= qty
 */

export const MOVEMENT_KINDS = ["receive", "reserve", "release", "consume", "adjust", "checkout", "checkin"] as const;
export type MovementKind = (typeof MOVEMENT_KINDS)[number];

export class InsufficientStockError extends Error {
  readonly code = "INSUFFICIENT_STOCK";
  constructor(
    public readonly productId: string,
    public readonly productName: string,
    public readonly requested: number,
    public readonly available: number
  ) {
    super(`Insufficient stock for "${productName}": requested ${requested}, available ${available}`);
    this.name = "InsufficientStockError";
  }
}

export function isInsufficientStock(e: unknown): e is InsufficientStockError {
  return e instanceof InsufficientStockError || (e instanceof Error && e.name === "InsufficientStockError");
}

export interface StockMovementRow {
  id: string;
  user_id: string;
  product_id: string;
  kind: MovementKind;
  qty: number;
  ref_kind: string | null;
  ref_id: string | null;
  note: string | null;
  created_by: string | null;
  created_at: string;
}

export interface StockOp {
  product_id: string;
  qty: number;
}

/**
 * Pure: collapse line items into per-product integer quantities, keeping only
 * products that exist and track stock. Fractional quantities round up (you
 * cannot ship 0.5 of a tracked unit). Items without `product_id` are ignored.
 */
export function planStockOps(
  items: ReadonlyArray<Pick<LineItem, "qty"> & { product_id?: string | null }>,
  products: ReadonlyMap<string, Pick<ProductDTO, "id" | "track_stock">>
): StockOp[] {
  const byProduct = new Map<string, number>();
  for (const it of items) {
    if (!it.product_id) continue;
    const p = products.get(it.product_id);
    if (!p || !p.track_stock) continue;
    const q = Math.ceil(Number(it.qty) || 0);
    if (q <= 0) continue;
    byProduct.set(p.id, (byProduct.get(p.id) ?? 0) + q);
  }
  return [...byProduct.entries()].map(([product_id, qty]) => ({ product_id, qty }));
}

/** Pure: given ledger rows for one ref, how much is still reserved per product. */
export function outstandingReservations(rows: ReadonlyArray<Pick<StockMovementRow, "product_id" | "kind" | "qty">>): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of rows) {
    const q = Number(r.qty) || 0;
    if (r.kind === "reserve" || r.kind === "checkout") out.set(r.product_id, (out.get(r.product_id) ?? 0) + q);
    else if (r.kind === "release" || r.kind === "checkin" || r.kind === "consume") out.set(r.product_id, (out.get(r.product_id) ?? 0) - q);
  }
  for (const [k, v] of out) if (v <= 0) out.delete(k);
  return out;
}

async function logMovement(
  dataId: string,
  m: { product_id: string; kind: MovementKind; qty: number; ref_kind?: string | null; ref_id?: string | null; note?: string | null; created_by?: string | null }
): Promise<StockMovementRow> {
  const id = randomUUID();
  await query(
    `INSERT INTO stock_movements (id, user_id, product_id, kind, qty, ref_kind, ref_id, note, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [id, dataId, m.product_id, m.kind, m.qty, m.ref_kind ?? null, m.ref_id ?? null, m.note ?? null, m.created_by ?? null]
  );
  const row = await queryOne<StockMovementRow>(`SELECT * FROM stock_movements WHERE id = $1`, [id]);
  if (!row) throw new Error("Movement vanished after insert");
  return row;
}

export async function listMovements(dataId: string, productId: string, limit = 100): Promise<StockMovementRow[]> {
  return query<StockMovementRow>(
    `SELECT * FROM stock_movements WHERE user_id = $1 AND product_id = $2 ORDER BY created_at DESC LIMIT $3`,
    [dataId, productId, Math.min(Math.max(limit, 1), 500)]
  );
}

/**
 * Atomically reserve `qty` of a product. Throws InsufficientStockError when
 * on_hand − reserved < qty. Returns the product after the change.
 */
async function reserveOne(dataId: string, productId: string, qty: number): Promise<void> {
  await withRetry(async () => {
    const rows = await query<{ id: string }>(
      `UPDATE products SET stock_reserved = stock_reserved + $3, updated_at = NOW()
        WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL AND track_stock = TRUE
          AND stock_on_hand - stock_reserved >= $3
        RETURNING id`,
      [productId, dataId, qty]
    );
    if (rows.length === 0) {
      const p = await getProduct(dataId, productId);
      if (!p) throw new Error("Product not found");
      if (!p.track_stock) return; // untracked: nothing to reserve
      throw new InsufficientStockError(p.id, p.name, qty, p.stock_available);
    }
  });
}

async function unreserveOne(dataId: string, productId: string, qty: number): Promise<void> {
  await withRetry(async () => {
    await query(
      `UPDATE products SET stock_reserved = GREATEST(stock_reserved - $3, 0), updated_at = NOW()
        WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
      [productId, dataId, qty]
    );
  });
}

export interface AdjustStockInput {
  kind: Extract<MovementKind, "receive" | "adjust" | "consume">;
  /** receive/consume: positive. adjust: signed delta. */
  qty: number;
  note?: string | null;
  ref_kind?: string | null;
  ref_id?: string | null;
}

/** Manual stock change on one product (receive, consume, or signed adjust). */
export async function adjustStock(dataId: string, productId: string, input: AdjustStockInput, actorId?: string | null): Promise<ProductDTO> {
  const qty = Math.trunc(input.qty);
  if (!Number.isFinite(qty) || qty === 0) throw new Error("qty must be a non-zero integer");
  if ((input.kind === "receive" || input.kind === "consume") && qty < 0) throw new Error(`${input.kind} qty must be positive`);
  const delta = input.kind === "consume" ? -qty : qty;
  await withRetry(async () => {
    const rows = await query<{ id: string }>(
      `UPDATE products SET stock_on_hand = stock_on_hand + $3, track_stock = TRUE, updated_at = NOW()
        WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL AND stock_on_hand - stock_reserved + $3 >= 0
        RETURNING id`,
      [productId, dataId, delta]
    );
    if (rows.length === 0) {
      const p = await getProduct(dataId, productId);
      if (!p) throw new Error("Product not found");
      throw new InsufficientStockError(p.id, p.name, -delta, p.stock_available);
    }
  });
  await logMovement(dataId, { product_id: productId, kind: input.kind, qty, ref_kind: input.ref_kind ?? "manual", ref_id: input.ref_id ?? null, note: input.note ?? null, created_by: actorId ?? null });
  const p = await getProduct(dataId, productId);
  if (!p) throw new Error("Product not found");
  return p;
}

export interface ReserveResult {
  reserved: StockOp[];
  /** True when the quote already had reservations and nothing was changed. */
  alreadyReserved: boolean;
}

/**
 * Reserve tracked stock for an accepted quote. Idempotent per quote: a second
 * call is a no-op. On an InsufficientStockError every reservation made by this
 * call is rolled back before rethrowing.
 *
 * Wire into src/lib/money/acceptance.ts after the quote is marked accepted:
 *   await reserveForQuote(owner, quoteId, q.items);
 */
export async function reserveForQuote(dataId: string, quoteId: string, items: readonly LineItem[]): Promise<ReserveResult> {
  const prior = await query<StockMovementRow>(
    `SELECT product_id, kind, qty FROM stock_movements WHERE user_id = $1 AND ref_kind = 'quote' AND ref_id = $2`,
    [dataId, quoteId]
  );
  if (outstandingReservations(prior).size > 0) {
    return { reserved: [...outstandingReservations(prior)].map(([product_id, qty]) => ({ product_id, qty })), alreadyReserved: true };
  }
  const products = await getProductsByIds(dataId, items.map((i) => i.product_id ?? "").filter(Boolean));
  const ops = planStockOps(items, products);
  const done: StockOp[] = [];
  try {
    for (const op of ops) {
      await reserveOne(dataId, op.product_id, op.qty);
      done.push(op);
      await logMovement(dataId, { product_id: op.product_id, kind: "reserve", qty: op.qty, ref_kind: "quote", ref_id: quoteId, note: "Quote accepted" });
    }
  } catch (err) {
    for (const op of done) {
      await unreserveOne(dataId, op.product_id, op.qty).catch(() => undefined);
      await logMovement(dataId, { product_id: op.product_id, kind: "release", qty: op.qty, ref_kind: "quote", ref_id: quoteId, note: "Rolled back: reservation failed" }).catch(() => undefined);
    }
    throw err;
  }
  return { reserved: done, alreadyReserved: false };
}

/** Release whatever is still reserved for a quote (declined / expired / voided). */
export async function releaseForQuote(dataId: string, quoteId: string, note = "Quote released"): Promise<StockOp[]> {
  const rows = await query<StockMovementRow>(
    `SELECT product_id, kind, qty FROM stock_movements WHERE user_id = $1 AND ref_kind = 'quote' AND ref_id = $2`,
    [dataId, quoteId]
  );
  const open = outstandingReservations(rows);
  const released: StockOp[] = [];
  for (const [product_id, qty] of open) {
    await unreserveOne(dataId, product_id, qty);
    await logMovement(dataId, { product_id, kind: "release", qty, ref_kind: "quote", ref_id: quoteId, note });
    released.push({ product_id, qty });
  }
  return released;
}

/**
 * Consume stock for an invoice (goods shipped / job done). If the invoice came
 * from a quote with open reservations, those reservations are cleared as the
 * stock leaves. Idempotent per invoice.
 */
export async function consumeForInvoice(
  dataId: string,
  invoiceId: string,
  items: readonly LineItem[],
  opts: { quoteId?: string | null } = {}
): Promise<StockOp[]> {
  const prior = await query<StockMovementRow>(
    `SELECT product_id, kind, qty FROM stock_movements WHERE user_id = $1 AND ref_kind = 'invoice' AND ref_id = $2 AND kind = 'consume'`,
    [dataId, invoiceId]
  );
  // Products already consumed for this invoice (a previous call may have stopped
  // part-way on an InsufficientStockError); never consume them twice, but do
  // finish the rest so a retry completes the invoice.
  const alreadyConsumed = new Set(prior.map((r) => r.product_id));
  const consumed: StockOp[] = prior.map((r) => ({ product_id: r.product_id, qty: Number(r.qty) }));

  const products = await getProductsByIds(dataId, items.map((i) => i.product_id ?? "").filter(Boolean));
  const ops = planStockOps(items, products).filter((op) => !alreadyConsumed.has(op.product_id));
  if (ops.length === 0) return consumed;

  let reservedForQuote = new Map<string, number>();
  if (opts.quoteId) {
    const rows = await query<StockMovementRow>(
      `SELECT product_id, kind, qty FROM stock_movements WHERE user_id = $1 AND ref_kind = 'quote' AND ref_id = $2`,
      [dataId, opts.quoteId]
    );
    reservedForQuote = outstandingReservations(rows);
  }

  for (const op of ops) {
    const fromReservation = Math.min(reservedForQuote.get(op.product_id) ?? 0, op.qty);
    await withRetry(async () => {
      // Available after releasing this product's own reservation must cover the qty.
      const rows = await query<{ id: string }>(
        `UPDATE products
            SET stock_on_hand = stock_on_hand - $3,
                stock_reserved = GREATEST(stock_reserved - $4, 0),
                updated_at = NOW()
          WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL AND track_stock = TRUE
            AND stock_on_hand - (stock_reserved - $4) >= $3
          RETURNING id`,
        [op.product_id, dataId, op.qty, fromReservation]
      );
      if (rows.length === 0) {
        const p = await getProduct(dataId, op.product_id);
        if (!p) throw new Error("Product not found");
        throw new InsufficientStockError(p.id, p.name, op.qty, p.stock_available + fromReservation);
      }
    });
    await logMovement(dataId, { product_id: op.product_id, kind: "consume", qty: op.qty, ref_kind: "invoice", ref_id: invoiceId, note: "Invoice billed" });
    if (fromReservation > 0 && opts.quoteId) {
      // Record the reservation clearing against the quote so outstandingReservations() nets to zero.
      await logMovement(dataId, { product_id: op.product_id, kind: "release", qty: fromReservation, ref_kind: "quote", ref_id: opts.quoteId, note: `Consumed by invoice ${invoiceId}` });
    }
    consumed.push(op);
  }
  return consumed;
}

// ── Equipment checkouts ───────────────────────────────────────────────────────

export interface EquipmentCheckoutRow {
  id: string;
  user_id: string;
  product_id: string;
  qty: number;
  checked_out_to: string | null;
  ref_kind: string | null;
  ref_id: string | null;
  due_back_at: string | null;
  returned_at: string | null;
  created_at: string;
}

export interface EquipmentCheckoutDTO extends EquipmentCheckoutRow {
  product_name: string;
  product_sku: string | null;
  overdue: boolean;
}

function toCheckoutDTO(r: EquipmentCheckoutRow & { product_name: string; product_sku: string | null }): EquipmentCheckoutDTO {
  return {
    ...r,
    qty: Number(r.qty),
    overdue: !r.returned_at && Boolean(r.due_back_at && new Date(r.due_back_at).getTime() < Date.now()),
  };
}

const CHECKOUT_SELECT = `
  SELECT e.*, p.name AS product_name, p.sku AS product_sku
    FROM equipment_checkouts e LEFT JOIN products p ON p.id = e.product_id`;

export async function listCheckouts(dataId: string, opts: { open?: boolean; limit?: number } = {}): Promise<EquipmentCheckoutDTO[]> {
  const params: unknown[] = [dataId];
  let sql = `${CHECKOUT_SELECT} WHERE e.user_id = $1`;
  if (opts.open) sql += ` AND e.returned_at IS NULL`;
  params.push(Math.min(Math.max(opts.limit ?? 200, 1), 500));
  sql += ` ORDER BY (e.returned_at IS NULL) DESC, e.due_back_at ASC NULLS LAST, e.created_at DESC LIMIT $${params.length}`;
  const rows = await query<EquipmentCheckoutRow & { product_name: string; product_sku: string | null }>(sql, params);
  return rows.map(toCheckoutDTO);
}

export interface CheckoutInput {
  product_id: string;
  qty: number;
  checked_out_to?: string | null;
  ref_kind?: string | null;
  ref_id?: string | null;
  due_back_at?: string | null;
}

/** Check equipment out: reserves qty (so it cannot be double-booked) and opens a checkout row. */
export async function checkoutEquipment(dataId: string, input: CheckoutInput, actorId?: string | null): Promise<EquipmentCheckoutDTO> {
  const qty = Math.trunc(input.qty);
  if (qty <= 0) throw new Error("qty must be a positive integer");
  const p = await getProduct(dataId, input.product_id);
  if (!p) throw new Error("Product not found");
  if (p.track_stock) await reserveOne(dataId, p.id, qty);
  const id = randomUUID();
  await query(
    `INSERT INTO equipment_checkouts (id, user_id, product_id, qty, checked_out_to, ref_kind, ref_id, due_back_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [id, dataId, p.id, qty, input.checked_out_to ?? null, input.ref_kind ?? null, input.ref_id ?? null, input.due_back_at ?? null]
  );
  await logMovement(dataId, { product_id: p.id, kind: "checkout", qty, ref_kind: "checkout", ref_id: id, note: input.checked_out_to ? `Out to ${input.checked_out_to}` : null, created_by: actorId ?? null });
  const row = await queryOne<EquipmentCheckoutRow & { product_name: string; product_sku: string | null }>(`${CHECKOUT_SELECT} WHERE e.id = $1 AND e.user_id = $2`, [id, dataId]);
  if (!row) throw new Error("Checkout vanished after insert");
  return toCheckoutDTO(row);
}

/** Check equipment back in: releases the reservation. Idempotent. */
export async function checkinEquipment(dataId: string, checkoutId: string, actorId?: string | null): Promise<EquipmentCheckoutDTO> {
  const row = await queryOne<EquipmentCheckoutRow & { product_name: string; product_sku: string | null }>(`${CHECKOUT_SELECT} WHERE e.id = $1 AND e.user_id = $2`, [checkoutId, dataId]);
  if (!row) throw new Error("Checkout not found");
  if (row.returned_at) return toCheckoutDTO(row);
  const updated = await query<{ id: string }>(
    `UPDATE equipment_checkouts SET returned_at = NOW() WHERE id = $1 AND user_id = $2 AND returned_at IS NULL RETURNING id`,
    [checkoutId, dataId]
  );
  if (updated.length > 0) {
    const p = await getProduct(dataId, row.product_id);
    if (p?.track_stock) await unreserveOne(dataId, p.id, Number(row.qty));
    await logMovement(dataId, { product_id: row.product_id, kind: "checkin", qty: Number(row.qty), ref_kind: "checkout", ref_id: checkoutId, created_by: actorId ?? null });
  }
  const out = await queryOne<EquipmentCheckoutRow & { product_name: string; product_sku: string | null }>(`${CHECKOUT_SELECT} WHERE e.id = $1 AND e.user_id = $2`, [checkoutId, dataId]);
  return toCheckoutDTO(out ?? row);
}
