import { randomUUID } from "crypto";
import { query, queryOne, withRetry } from "@/lib/dsql";
import type { LineItem } from "@/lib/money/items";
import { getProduct, getProductsByIds, type ProductDTO } from "./products";
import { emitEvent } from "@/lib/events/bus";
import { findDefaultLocationId, getLocation } from "./locations";
import { availabilityFor, ensureLevelRow } from "./levels";
import { planAllocation } from "./locations-pure";

/**
 * Stock ledger. Every change to `products.stock_on_hand` / `stock_reserved`
 * goes through a conditional UPDATE (`WHERE stock_on_hand - stock_reserved >= qty`)
 * inside `withRetry`, so two concurrent reservations can never over-promise:
 * the UPDATE either applies atomically or returns zero rows.
 *
 * Multi-location: once an org has a location, the same statement also moves
 * the per-location `stock_levels` row (one data-modifying CTE, so the org-wide
 * totals and the breakdown can never drift). Orgs without locations keep the
 * legacy single-stock behaviour.
 *
 *   reserve  — quote accepted: reserved += qty       (available shrinks)
 *   release  — quote cancelled/voided: reserved -= qty
 *   consume  — invoice billed: on_hand -= qty, and any matching reservation is cleared
 *   receive  — stock in: on_hand += qty
 *   adjust   — manual count correction: on_hand += qty (qty may be negative)
 *   checkout — equipment out on a job: reserved += qty
 *   checkin  — equipment returned: reserved -= qty
 *   transfer_out / transfer_in — location-to-location moves (totals unchanged)
 */

export const MOVEMENT_KINDS = ["receive", "reserve", "release", "consume", "adjust", "checkout", "checkin", "transfer_out", "transfer_in"] as const;
export type MovementKind = (typeof MOVEMENT_KINDS)[number];

export class InsufficientStockError extends Error {
  readonly code = "INSUFFICIENT_STOCK";
  constructor(
    public readonly productId: string,
    public readonly productName: string,
    public readonly requested: number,
    public readonly available: number,
    public readonly locationId: string | null = null
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
  location_id?: string | null;
  transfer_id?: string | null;
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

export interface OutstandingEntry {
  product_id: string;
  location_id: string | null;
  qty: number;
}

/** Pure: like outstandingReservations but split per (product, location). A null location is a pre-locations reservation. */
export function outstandingByLocation(rows: ReadonlyArray<Pick<StockMovementRow, "product_id" | "kind" | "qty" | "location_id">>): OutstandingEntry[] {
  const out = new Map<string, OutstandingEntry>();
  for (const r of rows) {
    const q = Number(r.qty) || 0;
    const sign = r.kind === "reserve" || r.kind === "checkout" ? 1 : r.kind === "release" || r.kind === "checkin" || r.kind === "consume" ? -1 : 0;
    if (sign === 0) continue;
    const loc = r.location_id ?? null;
    const key = `${r.product_id}|${loc ?? ""}`;
    const cur = out.get(key) ?? { product_id: r.product_id, location_id: loc, qty: 0 };
    cur.qty += sign * q;
    out.set(key, cur);
  }
  return [...out.values()].filter((e) => e.qty > 0);
}

export interface LogMovementInput {
  product_id: string;
  kind: MovementKind;
  qty: number;
  ref_kind?: string | null;
  ref_id?: string | null;
  note?: string | null;
  created_by?: string | null;
  location_id?: string | null;
  transfer_id?: string | null;
}

export async function logMovement(dataId: string, m: LogMovementInput): Promise<StockMovementRow> {
  const id = randomUUID();
  await query(
    `INSERT INTO stock_movements (id, user_id, product_id, kind, qty, ref_kind, ref_id, note, created_by, location_id, transfer_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [id, dataId, m.product_id, m.kind, m.qty, m.ref_kind ?? null, m.ref_id ?? null, m.note ?? null, m.created_by ?? null, m.location_id ?? null, m.transfer_id ?? null]
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

/** Explicit location (must exist and be active) or the org default; null = legacy single-stock mode. */
export async function resolveLocation(dataId: string, requested?: string | null): Promise<string | null> {
  if (requested) {
    const l = await getLocation(dataId, requested);
    if (!l) throw new Error("Location not found");
    if (!l.active) throw new Error("Location is archived");
    return l.id;
  }
  return findDefaultLocationId(dataId);
}

interface MoveOpts {
  onHand: number;
  reserved: number;
  /** adjust/receive may switch tracking on; otherwise the product must already track stock. */
  setTrack?: boolean;
  requireTracked?: boolean;
}

/**
 * The single conditional stock mutation. Returns false when the condition
 * (no negative on-hand, no over-reservation, tracked) does not hold. With a
 * location the level row and the org-wide product totals change in ONE
 * statement; without one only the product totals change (legacy).
 */
async function moveStock(dataId: string, productId: string, locationId: string | null, o: MoveOpts): Promise<boolean> {
  const setTrack = o.setTrack === true;
  const requireTracked = o.requireTracked === true;
  if (!locationId) {
    const rows = await query<{ id: string }>(
      `UPDATE products SET stock_on_hand = stock_on_hand + $3, stock_reserved = GREATEST(stock_reserved + $4, 0), track_stock = (track_stock OR $5::boolean), updated_at = NOW()
        WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL AND (NOT $6::boolean OR track_stock OR $5::boolean)
          AND stock_on_hand + $3 >= 0 AND stock_on_hand + $3 - GREATEST(stock_reserved + $4, 0) >= 0
        RETURNING id`,
      [productId, dataId, o.onHand, o.reserved, setTrack, requireTracked]
    );
    return rows.length > 0;
  }
  await ensureLevelRow(dataId, productId, locationId);
  const rows = await query<{ id: string }>(
    `WITH lvl AS (
       UPDATE stock_levels SET on_hand = on_hand + $4, reserved = GREATEST(reserved + $5, 0), updated_at = NOW()
        WHERE user_id = $1 AND product_id = $2 AND location_id = $3
          AND on_hand + $4 >= 0 AND on_hand + $4 - GREATEST(reserved + $5, 0) >= 0
          AND EXISTS (SELECT 1 FROM products p WHERE p.id = $2 AND p.user_id = $1 AND p.deleted_at IS NULL AND (NOT $7::boolean OR p.track_stock OR $6::boolean))
        RETURNING 1 AS ok
     )
     UPDATE products SET stock_on_hand = stock_on_hand + $4, stock_reserved = GREATEST(stock_reserved + $5, 0), track_stock = (track_stock OR $6::boolean), updated_at = NOW()
      WHERE id = $2 AND user_id = $1 AND deleted_at IS NULL AND EXISTS (SELECT 1 FROM lvl)
      RETURNING id`,
    [dataId, productId, locationId, o.onHand, o.reserved, setTrack, requireTracked]
  );
  return rows.length > 0;
}

/**
 * Move stock between a location's levels only (org totals unchanged): used by
 * transfers, which shift units without changing what the org owns.
 */
export async function moveLevelOnly(dataId: string, productId: string, locationId: string, deltaOnHand: number): Promise<boolean> {
  await ensureLevelRow(dataId, productId, locationId);
  const rows = await query<{ product_id: string }>(
    `UPDATE stock_levels SET on_hand = on_hand + $4, updated_at = NOW()
      WHERE user_id = $1 AND product_id = $2 AND location_id = $3 AND on_hand + $4 - reserved >= 0
      RETURNING product_id`,
    [dataId, productId, locationId, deltaOnHand]
  );
  return rows.length > 0;
}

/** Org-wide product totals only (shortage write-offs: units that left the org while in transit). */
export async function moveProductOnly(dataId: string, productId: string, deltaOnHand: number): Promise<boolean> {
  const rows = await query<{ id: string }>(
    `UPDATE products SET stock_on_hand = stock_on_hand + $3, updated_at = NOW()
      WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL AND stock_on_hand + $3 >= 0 RETURNING id`,
    [productId, dataId, deltaOnHand]
  );
  return rows.length > 0;
}

async function availableFor(dataId: string, p: ProductDTO, locationId: string | null): Promise<number> {
  if (!locationId) return p.stock_available;
  const r = await queryOne<{ on_hand: number | string; reserved: number | string }>(
    `SELECT on_hand, reserved FROM stock_levels WHERE user_id = $1 AND product_id = $2 AND location_id = $3`,
    [dataId, p.id, locationId]
  );
  return r ? Number(r.on_hand) - Number(r.reserved) : 0;
}

/**
 * Atomically reserve `qty` of a product at a location. Throws
 * InsufficientStockError when on_hand − reserved < qty.
 */
async function reserveOne(dataId: string, productId: string, qty: number, locationId: string | null): Promise<void> {
  await withRetry(async () => {
    const ok = await moveStock(dataId, productId, locationId, { onHand: 0, reserved: qty, requireTracked: true });
    if (!ok) {
      const p = await getProduct(dataId, productId);
      if (!p) throw new Error("Product not found");
      if (!p.track_stock) return; // untracked: nothing to reserve
      throw new InsufficientStockError(p.id, p.name, qty, await availableFor(dataId, p, locationId), locationId);
    }
  });
}

async function unreserveOne(dataId: string, productId: string, qty: number, locationId: string | null): Promise<void> {
  await withRetry(async () => {
    await moveStock(dataId, productId, locationId, { onHand: 0, reserved: -qty });
  });
}

export interface AdjustStockInput {
  kind: Extract<MovementKind, "receive" | "adjust" | "consume">;
  /** receive/consume: positive. adjust: signed delta. */
  qty: number;
  note?: string | null;
  ref_kind?: string | null;
  ref_id?: string | null;
  /** Location to apply the change at (default location when the org uses locations). */
  location_id?: string | null;
}

/** Manual stock change on one product (receive, consume, or signed adjust). */
export async function adjustStock(dataId: string, productId: string, input: AdjustStockInput, actorId?: string | null): Promise<ProductDTO> {
  const qty = Math.trunc(input.qty);
  if (!Number.isFinite(qty) || qty === 0) throw new Error("qty must be a non-zero integer");
  if ((input.kind === "receive" || input.kind === "consume") && qty < 0) throw new Error(`${input.kind} qty must be positive`);
  const delta = input.kind === "consume" ? -qty : qty;
  const loc = await resolveLocation(dataId, input.location_id);
  await withRetry(async () => {
    const ok = await moveStock(dataId, productId, loc, { onHand: delta, reserved: 0, setTrack: true });
    if (!ok) {
      const p = await getProduct(dataId, productId);
      if (!p) throw new Error("Product not found");
      throw new InsufficientStockError(p.id, p.name, -delta, await availableFor(dataId, p, loc), loc);
    }
  });
  await logMovement(dataId, { product_id: productId, kind: input.kind, qty, ref_kind: input.ref_kind ?? "manual", ref_id: input.ref_id ?? null, note: input.note ?? null, created_by: actorId ?? null, location_id: loc });
  const p = await getProduct(dataId, productId);
  if (!p) throw new Error("Product not found");
  void emitEvent(dataId, {
    type: "product.stock_changed",
    entity: "product",
    entityId: productId,
    data: { kind: input.kind, qty, stock_on_hand: p.stock_on_hand, stock_available: p.stock_available, low_stock: p.low_stock, location_id: loc },
  });
  return p;
}

export interface ReserveResult {
  reserved: StockOp[];
  /** True when the quote already had reservations and nothing was changed. */
  alreadyReserved: boolean;
}

type ReservationRef = "quote" | "order";

export interface ReserveOpts {
  /** Location to fill from first; the rest comes from other locations by availability. */
  preferLocationId?: string | null;
}

interface PlannedReserve {
  product_id: string;
  location_id: string | null;
  qty: number;
}

/** Decide where each unit comes from: preferred/default location first, then the rest (locations orgs); one legacy bucket otherwise. */
async function planReservations(dataId: string, ops: StockOp[], products: ReadonlyMap<string, ProductDTO>, prefer?: string | null): Promise<PlannedReserve[]> {
  const def = await findDefaultLocationId(dataId);
  if (!def) return ops.map((o) => ({ product_id: o.product_id, location_id: null, qty: o.qty }));
  const avail = await availabilityFor(dataId, ops.map((o) => o.product_id));
  const plan = planAllocation(ops, avail, prefer && (await getLocation(dataId, prefer)) ? prefer : def);
  const first = plan.shortages[0];
  if (first) {
    const p = products.get(first.product_id);
    throw new InsufficientStockError(first.product_id, p?.name ?? first.product_id, first.requested, first.requested - first.short);
  }
  return plan.allocations;
}

/**
 * Allocate (without reserving) items across locations: preferred location
 * first, then others by availability. For callers that want to show/plan a split.
 */
export async function allocateStock(
  dataId: string,
  items: ReadonlyArray<Pick<LineItem, "qty"> & { product_id?: string | null }>,
  opts: ReserveOpts = {}
): Promise<{ allocations: PlannedReserve[]; shortages: Array<{ product_id: string; requested: number; short: number }> }> {
  const products = await getProductsByIds(dataId, items.map((i) => i.product_id ?? "").filter(Boolean));
  const ops = planStockOps(items, products);
  const def = await findDefaultLocationId(dataId);
  if (!def) return { allocations: ops.map((o) => ({ product_id: o.product_id, location_id: null, qty: o.qty })), shortages: [] };
  const avail = await availabilityFor(dataId, ops.map((o) => o.product_id));
  const plan = planAllocation(ops, avail, opts.preferLocationId ?? def);
  return { allocations: plan.allocations, shortages: plan.shortages };
}

/**
 * Reserve tracked stock against a reference (quote or order). Idempotent per
 * ref: a second call is a no-op. On an InsufficientStockError every
 * reservation made by this call is rolled back before rethrowing.
 */
async function reserveForRef(dataId: string, refKind: ReservationRef, refId: string, items: readonly LineItem[], note: string, opts: ReserveOpts = {}): Promise<ReserveResult> {
  const prior = await query<StockMovementRow>(
    `SELECT product_id, kind, qty FROM stock_movements WHERE user_id = $1 AND ref_kind = $2 AND ref_id = $3`,
    [dataId, refKind, refId]
  );
  if (outstandingReservations(prior).size > 0) {
    return { reserved: [...outstandingReservations(prior)].map(([product_id, qty]) => ({ product_id, qty })), alreadyReserved: true };
  }
  const products = await getProductsByIds(dataId, items.map((i) => i.product_id ?? "").filter(Boolean));
  const ops = planStockOps(items, products);
  const plan = await planReservations(dataId, ops, products, opts.preferLocationId);
  const done: PlannedReserve[] = [];
  try {
    for (const a of plan) {
      await reserveOne(dataId, a.product_id, a.qty, a.location_id);
      done.push(a);
      await logMovement(dataId, { product_id: a.product_id, kind: "reserve", qty: a.qty, ref_kind: refKind, ref_id: refId, note, location_id: a.location_id });
    }
  } catch (err) {
    for (const a of done) {
      await unreserveOne(dataId, a.product_id, a.qty, a.location_id).catch(() => undefined);
      await logMovement(dataId, { product_id: a.product_id, kind: "release", qty: a.qty, ref_kind: refKind, ref_id: refId, note: "Rolled back: reservation failed", location_id: a.location_id }).catch(() => undefined);
    }
    throw err;
  }
  const byProduct = new Map<string, number>();
  for (const d of done) byProduct.set(d.product_id, (byProduct.get(d.product_id) ?? 0) + d.qty);
  return { reserved: [...byProduct].map(([product_id, qty]) => ({ product_id, qty })), alreadyReserved: false };
}

async function releaseForRef(dataId: string, refKind: ReservationRef, refId: string, note: string): Promise<StockOp[]> {
  const rows = await query<StockMovementRow>(
    `SELECT product_id, kind, qty, location_id FROM stock_movements WHERE user_id = $1 AND ref_kind = $2 AND ref_id = $3`,
    [dataId, refKind, refId]
  );
  const open = outstandingByLocation(rows);
  const def = open.length > 0 ? await findDefaultLocationId(dataId) : null;
  const released = new Map<string, number>();
  for (const e of open) {
    const loc = e.location_id ?? def;
    await unreserveOne(dataId, e.product_id, e.qty, loc);
    await logMovement(dataId, { product_id: e.product_id, kind: "release", qty: e.qty, ref_kind: refKind, ref_id: refId, note, location_id: e.location_id });
    released.set(e.product_id, (released.get(e.product_id) ?? 0) + e.qty);
  }
  return [...released].map(([product_id, qty]) => ({ product_id, qty }));
}

/**
 * Reserve tracked stock for an accepted quote. Idempotent per quote.
 *
 * Wire into src/lib/money/acceptance.ts after the quote is marked accepted:
 *   await reserveForQuote(owner, quoteId, q.items);
 */
export async function reserveForQuote(dataId: string, quoteId: string, items: readonly LineItem[], opts: ReserveOpts = {}): Promise<ReserveResult> {
  return reserveForRef(dataId, "quote", quoteId, items, "Quote accepted", opts);
}

/** Release whatever is still reserved for a quote (declined / expired / voided). */
export async function releaseForQuote(dataId: string, quoteId: string, note = "Quote released"): Promise<StockOp[]> {
  return releaseForRef(dataId, "quote", quoteId, note);
}

/** Storefront: reserve stock when an order is placed (pending payment). Idempotent per order. */
export async function reserveForOrder(dataId: string, orderId: string, items: readonly LineItem[], opts: ReserveOpts = {}): Promise<ReserveResult> {
  return reserveForRef(dataId, "order", orderId, items, "Order placed", opts);
}

/** Storefront: release an order's reservation (cancelled / expired unpaid). */
export async function releaseForOrder(dataId: string, orderId: string, note = "Order cancelled"): Promise<StockOp[]> {
  return releaseForRef(dataId, "order", orderId, note);
}

/**
 * Storefront: goods leave the shelf once the order is paid. Consumes against
 * the order's linked invoice (so the invoice-side consumption is a no-op) and
 * clears the order reservation. Idempotent per invoice.
 */
export async function consumeForOrder(dataId: string, orderId: string, invoiceId: string, items: readonly LineItem[]): Promise<StockOp[]> {
  return consumeForInvoice(dataId, invoiceId, items, { reservation: { kind: "order", id: orderId } });
}

/**
 * Consume stock for an invoice (goods shipped / job done). If the invoice came
 * from a quote (or storefront order) with open reservations, those
 * reservations are cleared as the stock leaves, at the location(s) they were
 * reserved at. Idempotent per invoice.
 */
export async function consumeForInvoice(
  dataId: string,
  invoiceId: string,
  items: readonly LineItem[],
  opts: { quoteId?: string | null; reservation?: { kind: ReservationRef; id: string } | null; locationId?: string | null } = {}
): Promise<StockOp[]> {
  const prior = await query<StockMovementRow>(
    `SELECT product_id, kind, qty FROM stock_movements WHERE user_id = $1 AND ref_kind = 'invoice' AND ref_id = $2 AND kind = 'consume'`,
    [dataId, invoiceId]
  );
  // Quantity already consumed per product for this invoice (a previous call may have stopped
  // part-way on an InsufficientStockError); never consume it twice, but do finish the rest so a retry completes the invoice.
  const priorQty = new Map<string, number>();
  for (const r of prior) priorQty.set(r.product_id, (priorQty.get(r.product_id) ?? 0) + Number(r.qty));
  const consumed: StockOp[] = [...priorQty].map(([product_id, qty]) => ({ product_id, qty }));

  const products = await getProductsByIds(dataId, items.map((i) => i.product_id ?? "").filter(Boolean));
  const ops = planStockOps(items, products)
    .map((op) => ({ product_id: op.product_id, qty: op.qty - (priorQty.get(op.product_id) ?? 0) }))
    .filter((op) => op.qty > 0);
  if (ops.length === 0) return consumed;

  const ref = opts.reservation ?? (opts.quoteId ? { kind: "quote" as const, id: opts.quoteId } : null);
  let reserved: OutstandingEntry[] = [];
  if (ref) {
    const rows = await query<StockMovementRow>(
      `SELECT product_id, kind, qty, location_id FROM stock_movements WHERE user_id = $1 AND ref_kind = $2 AND ref_id = $3`,
      [dataId, ref.kind, ref.id]
    );
    reserved = outstandingByLocation(rows);
  }
  const def = await findDefaultLocationId(dataId);

  const consumeAt = async (productId: string, entryLoc: string | null, loc: string | null, qty: number, fromReservation: number): Promise<void> => {
    await withRetry(async () => {
      // Available after releasing this product's own reservation must cover the qty.
      const ok = await moveStock(dataId, productId, loc, { onHand: -qty, reserved: -fromReservation, requireTracked: true });
      if (!ok) {
        const p = await getProduct(dataId, productId);
        if (!p) throw new Error("Product not found");
        throw new InsufficientStockError(p.id, p.name, qty, (await availableFor(dataId, p, loc)) + fromReservation, loc);
      }
    });
    await logMovement(dataId, { product_id: productId, kind: "consume", qty, ref_kind: "invoice", ref_id: invoiceId, note: "Invoice billed", location_id: loc });
    if (fromReservation > 0 && ref) {
      // Record the reservation clearing against the ref so outstandingReservations() nets to zero.
      await logMovement(dataId, { product_id: productId, kind: "release", qty: fromReservation, ref_kind: ref.kind, ref_id: ref.id, note: `Consumed by invoice ${invoiceId}`, location_id: entryLoc });
    }
  };

  for (const op of ops) {
    let remaining = op.qty;
    for (const e of reserved.filter((r) => r.product_id === op.product_id)) {
      if (remaining <= 0) break;
      const take = Math.min(remaining, e.qty);
      await consumeAt(op.product_id, e.location_id, e.location_id ?? def, take, take);
      remaining -= take;
    }
    if (remaining > 0) {
      if (def) {
        const avail = await availabilityFor(dataId, [op.product_id]);
        const plan = planAllocation([{ product_id: op.product_id, qty: remaining }], avail, opts.locationId ?? def);
        for (const a of plan.allocations) await consumeAt(op.product_id, null, a.location_id, a.qty, 0);
        const short = plan.shortages[0];
        if (short) {
          const p = products.get(op.product_id);
          throw new InsufficientStockError(op.product_id, p?.name ?? op.product_id, short.requested, short.requested - short.short);
        }
      } else {
        await consumeAt(op.product_id, null, null, remaining, 0);
      }
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
  const loc = p.track_stock ? await resolveLocation(dataId, null) : null;
  if (p.track_stock) await reserveOne(dataId, p.id, qty, loc);
  const id = randomUUID();
  await query(
    `INSERT INTO equipment_checkouts (id, user_id, product_id, qty, checked_out_to, ref_kind, ref_id, due_back_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [id, dataId, p.id, qty, input.checked_out_to ?? null, input.ref_kind ?? null, input.ref_id ?? null, input.due_back_at ?? null]
  );
  await logMovement(dataId, { product_id: p.id, kind: "checkout", qty, ref_kind: "checkout", ref_id: id, note: input.checked_out_to ? `Out to ${input.checked_out_to}` : null, created_by: actorId ?? null, location_id: loc });
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
    const out = await queryOne<{ location_id: string | null }>(
      `SELECT location_id FROM stock_movements WHERE user_id = $1 AND ref_kind = 'checkout' AND ref_id = $2 AND kind = 'checkout' LIMIT 1`,
      [dataId, checkoutId]
    );
    const loc = out?.location_id ?? (p?.track_stock ? await findDefaultLocationId(dataId) : null);
    if (p?.track_stock) await unreserveOne(dataId, p.id, Number(row.qty), loc);
    await logMovement(dataId, { product_id: row.product_id, kind: "checkin", qty: Number(row.qty), ref_kind: "checkout", ref_id: checkoutId, created_by: actorId ?? null, location_id: loc });
  }
  const out = await queryOne<EquipmentCheckoutRow & { product_name: string; product_sku: string | null }>(`${CHECKOUT_SELECT} WHERE e.id = $1 AND e.user_id = $2`, [checkoutId, dataId]);
  return toCheckoutDTO(out ?? row);
}
