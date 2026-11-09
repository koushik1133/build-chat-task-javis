import { randomUUID } from "crypto";
import { z } from "zod";
import { query, queryOne, withRetry } from "@/lib/dsql";
import { nextDocNumber } from "@/lib/docs/numbering";
import { emitEvent } from "@/lib/events/bus";
import { getProductsByIds } from "./products";
import { getLocation } from "./locations";
import { InsufficientStockError, logMovement, moveLevelOnly, moveProductOnly } from "./stock";
import { canTransferAct, clampReceive, isFullyReceived, remainingQty, type TransferStatus } from "./locations-pure";

/**
 * Location-to-location transfers. Shipping takes units out of the source
 * level, receiving puts them into the destination level; the org-wide product
 * totals do not change (units on an in-transit transfer still belong to the
 * org), except for shortages written off at close.
 */

export const TransferLineInput = z.object({ product_id: z.string().min(1).max(100), qty: z.number().int().min(1).max(1_000_000) }).strict();
export const TransferCreateSchema = z
  .object({
    from_location_id: z.string().min(1).max(100),
    to_location_id: z.string().min(1).max(100),
    lines: z.array(TransferLineInput).min(1).max(200),
    note: z.string().trim().max(1000).nullable().optional(),
  })
  .strict();
export type TransferCreateInput = z.infer<typeof TransferCreateSchema>;

export const TransferReceiveSchema = z
  .object({
    lines: z.array(z.object({ product_id: z.string().min(1).max(100), received_qty: z.number().int().min(0).max(1_000_000) }).strict()).max(200).optional(),
    /** Write off whatever is still outstanding and close the transfer. */
    close_short: z.boolean().optional(),
  })
  .strict();
export type TransferReceiveInput = z.infer<typeof TransferReceiveSchema>;

export class TransferError extends Error {
  constructor(public readonly code: "not_found" | "bad_state" | "invalid", message: string) {
    super(message);
    this.name = "TransferError";
  }
}
export function isTransferError(e: unknown): e is TransferError {
  return e instanceof TransferError || (e instanceof Error && e.name === "TransferError");
}

interface TransferRow {
  id: string;
  user_id: string;
  number: string;
  from_location_id: string;
  to_location_id: string;
  status: TransferStatus;
  note: string | null;
  created_by: string | null;
  shipped_at: string | null;
  received_at: string | null;
  created_at: string;
  updated_at: string;
  from_name?: string | null;
  to_name?: string | null;
}
interface LineRow {
  id: string;
  transfer_id: string;
  product_id: string;
  qty: number | string;
  received_qty: number | string;
  product_name?: string | null;
  product_sku?: string | null;
}
export interface TransferLineDTO {
  id: string;
  product_id: string;
  product_name: string | null;
  product_sku: string | null;
  qty: number;
  received_qty: number;
  remaining: number;
}
export interface TransferDTO extends Omit<TransferRow, "user_id" | "from_name" | "to_name"> {
  from_name: string | null;
  to_name: string | null;
  lines: TransferLineDTO[];
}

const HEAD_SELECT = `SELECT t.*, lf.name AS from_name, lt.name AS to_name FROM stock_transfers t
  LEFT JOIN locations lf ON lf.id = t.from_location_id LEFT JOIN locations lt ON lt.id = t.to_location_id`;

async function loadLines(dataId: string, ids: string[]): Promise<Map<string, TransferLineDTO[]>> {
  const out = new Map<string, TransferLineDTO[]>();
  if (ids.length === 0) return out;
  const rows = await query<LineRow>(
    `SELECT l.*, p.name AS product_name, p.sku AS product_sku FROM stock_transfer_lines l LEFT JOIN products p ON p.id = l.product_id
      WHERE l.user_id = $1 AND l.transfer_id = ANY($2) ORDER BY p.name ASC`,
    [dataId, ids]
  );
  for (const r of rows) {
    const qty = Number(r.qty);
    const rec = Number(r.received_qty);
    const list = out.get(r.transfer_id) ?? [];
    list.push({ id: r.id, product_id: r.product_id, product_name: r.product_name ?? null, product_sku: r.product_sku ?? null, qty, received_qty: rec, remaining: remainingQty({ qty, received_qty: rec }) });
    out.set(r.transfer_id, list);
  }
  return out;
}

function toDTO(r: TransferRow, lines: TransferLineDTO[]): TransferDTO {
  const { user_id: _u, from_name, to_name, ...rest } = r;
  void _u;
  return { ...rest, from_name: from_name ?? null, to_name: to_name ?? null, lines };
}

export async function getTransfer(dataId: string, id: string): Promise<TransferDTO | null> {
  const r = await queryOne<TransferRow>(`${HEAD_SELECT} WHERE t.id = $1 AND t.user_id = $2`, [id, dataId]);
  if (!r) return null;
  return toDTO(r, (await loadLines(dataId, [id])).get(id) ?? []);
}

export async function listTransfers(dataId: string, opts: { status?: string | null; locationId?: string | null; limit?: number } = {}): Promise<TransferDTO[]> {
  const params: unknown[] = [dataId];
  let sql = `${HEAD_SELECT} WHERE t.user_id = $1`;
  if (opts.status) {
    params.push(opts.status);
    sql += ` AND t.status = $${params.length}`;
  }
  if (opts.locationId) {
    params.push(opts.locationId);
    sql += ` AND (t.from_location_id = $${params.length} OR t.to_location_id = $${params.length})`;
  }
  params.push(Math.min(Math.max(opts.limit ?? 100, 1), 500));
  sql += ` ORDER BY t.created_at DESC LIMIT $${params.length}`;
  const rows = await query<TransferRow>(sql, params);
  const lines = await loadLines(dataId, rows.map((r) => r.id));
  return rows.map((r) => toDTO(r, lines.get(r.id) ?? []));
}

export async function createTransfer(dataId: string, input: TransferCreateInput, actorId?: string | null): Promise<TransferDTO> {
  if (input.from_location_id === input.to_location_id) throw new TransferError("invalid", "Source and destination must differ");
  const [from, to] = await Promise.all([getLocation(dataId, input.from_location_id), getLocation(dataId, input.to_location_id)]);
  if (!from || !to) throw new TransferError("not_found", "Location not found");
  if (!from.active || !to.active) throw new TransferError("invalid", "Archived locations cannot be used in transfers");
  const ids = input.lines.map((l) => l.product_id);
  if (new Set(ids).size !== ids.length) throw new TransferError("invalid", "Each product can appear once per transfer");
  const products = await getProductsByIds(dataId, ids);
  for (const id of ids) {
    const p = products.get(id);
    if (!p) throw new TransferError("not_found", `Product ${id} not found`);
    if (!p.track_stock) throw new TransferError("invalid", `${p.name} does not track stock`);
  }
  const number = await nextDocNumber(dataId, "transfer");
  const id = randomUUID();
  await query(
    `INSERT INTO stock_transfers (id, user_id, number, from_location_id, to_location_id, status, note, created_by) VALUES ($1, $2, $3, $4, $5, 'draft', $6, $7)`,
    [id, dataId, number, from.id, to.id, input.note ?? null, actorId ?? null]
  );
  for (const l of input.lines) {
    await query(`INSERT INTO stock_transfer_lines (id, user_id, transfer_id, product_id, qty, received_qty) VALUES ($1, $2, $3, $4, $5, 0)`, [randomUUID(), dataId, id, l.product_id, l.qty]);
  }
  const out = await getTransfer(dataId, id);
  if (!out) throw new Error("Transfer vanished after insert");
  return out;
}

async function requireTransfer(dataId: string, id: string): Promise<TransferDTO> {
  const t = await getTransfer(dataId, id);
  if (!t) throw new TransferError("not_found", "Transfer not found");
  return t;
}

async function claim(dataId: string, id: string, from: TransferStatus, to: TransferStatus, setCol?: "shipped_at" | "received_at"): Promise<boolean> {
  const rows = await withRetry(() =>
    query<{ id: string }>(
      `UPDATE stock_transfers SET status = $4, ${setCol ? `${setCol} = NOW(),` : ""} updated_at = NOW() WHERE id = $1 AND user_id = $2 AND status = $3 RETURNING id`,
      [id, dataId, from, to]
    )
  );
  return rows.length > 0;
}

/** Ship: takes each line out of the source location (only unreserved units) and marks the transfer in transit. Idempotent. */
export async function shipTransfer(dataId: string, id: string, actorId?: string | null): Promise<TransferDTO> {
  const t = await requireTransfer(dataId, id);
  if (t.status === "in_transit") return t;
  if (!canTransferAct(t.status, "ship")) throw new TransferError("bad_state", `A ${t.status} transfer cannot be shipped`);
  if (!(await claim(dataId, id, "draft", "in_transit", "shipped_at"))) return requireTransfer(dataId, id);
  const done: TransferLineDTO[] = [];
  try {
    for (const l of t.lines) {
      const ok = await withRetry(() => moveLevelOnly(dataId, l.product_id, t.from_location_id, -l.qty));
      if (!ok) {
        const cur = await queryOne<{ on_hand: number | string; reserved: number | string }>(`SELECT on_hand, reserved FROM stock_levels WHERE user_id = $1 AND product_id = $2 AND location_id = $3`, [dataId, l.product_id, t.from_location_id]);
        throw new InsufficientStockError(l.product_id, l.product_name ?? l.product_id, l.qty, cur ? Number(cur.on_hand) - Number(cur.reserved) : 0, t.from_location_id);
      }
      done.push(l);
      await logMovement(dataId, { product_id: l.product_id, kind: "transfer_out", qty: l.qty, ref_kind: "transfer", ref_id: id, note: `Shipped on ${t.number}`, created_by: actorId ?? null, location_id: t.from_location_id, transfer_id: id });
    }
  } catch (err) {
    for (const l of done) {
      await moveLevelOnly(dataId, l.product_id, t.from_location_id, l.qty).catch(() => undefined);
      await logMovement(dataId, { product_id: l.product_id, kind: "transfer_in", qty: l.qty, ref_kind: "transfer", ref_id: id, note: "Rolled back: shipment failed", location_id: t.from_location_id, transfer_id: id }).catch(() => undefined);
    }
    await query(`UPDATE stock_transfers SET status = 'draft', shipped_at = NULL, updated_at = NOW() WHERE id = $1 AND user_id = $2 AND status = 'in_transit'`, [id, dataId]);
    throw err;
  }
  void emitEvent(dataId, { type: "stock.transfer_shipped", entity: "stock_transfer", entityId: id, data: { number: t.number, from_location_id: t.from_location_id, to_location_id: t.to_location_id, lines: t.lines.map((l) => ({ product_id: l.product_id, qty: l.qty })) } });
  return requireTransfer(dataId, id);
}

/**
 * Receive (fully or partially) at the destination. Omit `lines` to receive
 * everything outstanding. `close_short` writes off whatever is still missing
 * (an `adjust` movement lowers the org total) and closes the transfer.
 */
export async function receiveTransfer(dataId: string, id: string, input: TransferReceiveInput = {}, actorId?: string | null): Promise<TransferDTO> {
  const t = await requireTransfer(dataId, id);
  if (!canTransferAct(t.status, "receive")) throw new TransferError("bad_state", `A ${t.status} transfer cannot be received`);
  const requested = new Map<string, number>();
  if (input.lines) {
    for (const l of input.lines) {
      const line = t.lines.find((x) => x.product_id === l.product_id);
      if (!line) throw new TransferError("invalid", `Product ${l.product_id} is not on this transfer`);
      if (l.received_qty > line.remaining) throw new TransferError("invalid", `Cannot receive ${l.received_qty} of ${line.product_name ?? l.product_id}: only ${line.remaining} outstanding`);
      requested.set(l.product_id, l.received_qty);
    }
  } else {
    for (const l of t.lines) requested.set(l.product_id, l.remaining);
  }
  for (const [productId, want] of requested) {
    const line = t.lines.find((x) => x.product_id === productId);
    if (!line) continue;
    const qty = clampReceive(line, want);
    if (qty <= 0) continue;
    const claimed = await withRetry(() =>
      query<{ id: string }>(`UPDATE stock_transfer_lines SET received_qty = received_qty + $3 WHERE id = $1 AND user_id = $2 AND received_qty + $3 <= qty RETURNING id`, [line.id, dataId, qty])
    );
    if (claimed.length === 0) throw new TransferError("invalid", "This line was received concurrently; reload and retry");
    await withRetry(() => moveLevelOnly(dataId, productId, t.to_location_id, qty));
    await logMovement(dataId, { product_id: productId, kind: "transfer_in", qty, ref_kind: "transfer", ref_id: id, note: `Received on ${t.number}`, created_by: actorId ?? null, location_id: t.to_location_id, transfer_id: id });
  }
  const fresh = await requireTransfer(dataId, id);
  let close = isFullyReceived(fresh.lines);
  if (!close && input.close_short) {
    for (const l of fresh.lines) {
      if (l.remaining <= 0) continue;
      await withRetry(() => moveProductOnly(dataId, l.product_id, -l.remaining));
      await logMovement(dataId, { product_id: l.product_id, kind: "adjust", qty: -l.remaining, ref_kind: "transfer", ref_id: id, note: `Shortage written off on ${t.number}`, created_by: actorId ?? null, location_id: t.to_location_id, transfer_id: id });
    }
    close = true;
  }
  if (close) await claim(dataId, id, "in_transit", "received", "received_at");
  void emitEvent(dataId, { type: "stock.transfer_received", entity: "stock_transfer", entityId: id, data: { number: t.number, complete: close, lines: [...requested].map(([product_id, qty]) => ({ product_id, qty })) } });
  return requireTransfer(dataId, id);
}

/** Cancel a draft, or an in-transit transfer (outstanding units go back to the source). Idempotent. */
export async function cancelTransfer(dataId: string, id: string, actorId?: string | null): Promise<TransferDTO> {
  const t = await requireTransfer(dataId, id);
  if (t.status === "cancelled") return t;
  if (!canTransferAct(t.status, "cancel")) throw new TransferError("bad_state", `A ${t.status} transfer cannot be cancelled`);
  if (!(await claim(dataId, id, t.status, "cancelled"))) return requireTransfer(dataId, id);
  if (t.status === "in_transit") {
    for (const l of t.lines) {
      if (l.remaining <= 0) continue;
      await withRetry(() => moveLevelOnly(dataId, l.product_id, t.from_location_id, l.remaining));
      await logMovement(dataId, { product_id: l.product_id, kind: "transfer_in", qty: l.remaining, ref_kind: "transfer", ref_id: id, note: `Returned: ${t.number} cancelled`, created_by: actorId ?? null, location_id: t.from_location_id, transfer_id: id });
    }
  }
  return requireTransfer(dataId, id);
}
