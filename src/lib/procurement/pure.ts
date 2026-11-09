/**
 * Procurement math — pure and client-safe (no DB, no clock unless passed in).
 *
 *   receiveStatus()        received vs ordered → partially_received | received
 *   weightedAverageCost()  new unit cost after a receipt
 *   agingBucket()          days overdue → AP aging bucket
 *   suggestReorderQty()    how much to order for a low-stock product
 *   groupBySupplier()      reorder suggestions → one draft PO per supplier
 */

export const PO_STATUSES = ["draft", "sent", "partially_received", "received", "cancelled"] as const;
export type PoStatus = (typeof PO_STATUSES)[number];

export const BILL_STATUSES = ["draft", "open", "partially_paid", "paid", "void"] as const;
export type BillStatus = (typeof BILL_STATUSES)[number];

export const BILL_PAYMENT_METHODS = ["bank", "card", "cash", "cheque", "other"] as const;
export type BillPaymentMethod = (typeof BILL_PAYMENT_METHODS)[number];

export const AGING_BUCKETS = ["current", "d1_30", "d31_60", "d61_90", "d90_plus"] as const;
export type AgingBucket = (typeof AGING_BUCKETS)[number];
export const AGING_BUCKET_LABELS: Record<AgingBucket, string> = {
  current: "Current",
  d1_30: "1–30 days",
  d31_60: "31–60 days",
  d61_90: "61–90 days",
  d90_plus: "90+ days",
};

/** Per-product ordered vs received quantities. */
export interface ReceiptProgress {
  product_id: string;
  ordered: number;
  received: number;
}

/** Collapse PO lines into ordered qty per product (lines without product_id cannot be received into stock). */
export function orderedByProduct(items: ReadonlyArray<{ product_id?: string | null; qty: number }>): Map<string, number> {
  const out = new Map<string, number>();
  for (const it of items) {
    if (!it.product_id) continue;
    const q = Math.ceil(Number(it.qty) || 0);
    if (q <= 0) continue;
    out.set(it.product_id, (out.get(it.product_id) ?? 0) + q);
  }
  return out;
}

/** Sum receipt lines per product. */
export function receivedByProduct(receipts: ReadonlyArray<ReadonlyArray<{ product_id: string; qty: number }>>): Map<string, number> {
  const out = new Map<string, number>();
  for (const lines of receipts) {
    for (const l of lines) {
      const q = Math.trunc(Number(l.qty) || 0);
      if (q <= 0) continue;
      out.set(l.product_id, (out.get(l.product_id) ?? 0) + q);
    }
  }
  return out;
}

export function receiptProgress(ordered: ReadonlyMap<string, number>, received: ReadonlyMap<string, number>): ReceiptProgress[] {
  return [...ordered.entries()].map(([product_id, o]) => ({ product_id, ordered: o, received: Math.min(received.get(product_id) ?? 0, o) }));
}

/**
 * Status after a receipt. Fully received when every ordered product has been
 * received in full; anything received at all is "partially_received"; a PO
 * with no receivable lines cannot be received.
 */
export function receiveStatus(progress: ReadonlyArray<ReceiptProgress>): Extract<PoStatus, "partially_received" | "received"> | null {
  if (progress.length === 0) return null;
  const anyReceived = progress.some((p) => p.received > 0);
  if (!anyReceived) return null;
  return progress.every((p) => p.received >= p.ordered) ? "received" : "partially_received";
}

/** Lines that would over-receive: qty > ordered − already received. */
export function overReceipts(
  lines: ReadonlyArray<{ product_id: string; qty: number }>,
  ordered: ReadonlyMap<string, number>,
  received: ReadonlyMap<string, number>
): Array<{ product_id: string; requested: number; remaining: number }> {
  const out: Array<{ product_id: string; requested: number; remaining: number }> = [];
  const pending = new Map<string, number>();
  for (const l of lines) {
    const q = Math.trunc(Number(l.qty) || 0);
    if (q <= 0) continue;
    pending.set(l.product_id, (pending.get(l.product_id) ?? 0) + q);
  }
  for (const [pid, q] of pending) {
    const remaining = (ordered.get(pid) ?? 0) - (received.get(pid) ?? 0);
    if (q > remaining) out.push({ product_id: pid, requested: q, remaining: Math.max(remaining, 0) });
  }
  return out;
}

/**
 * Weighted average unit cost after receiving `qty` units at `unitCost`.
 * `onHandBefore` ≤ 0 means the new cost is simply the purchase cost.
 */
export function weightedAverageCost(onHandBefore: number, costBefore: number, qty: number, unitCost: number): number {
  const prev = Math.max(Math.trunc(onHandBefore), 0);
  const q = Math.max(Math.trunc(qty), 0);
  if (q === 0) return Math.max(Math.trunc(costBefore), 0);
  if (prev === 0 || costBefore <= 0) return Math.max(Math.trunc(unitCost), 0);
  return Math.floor((prev * costBefore + q * unitCost) / (prev + q) + 0.5);
}

/** Bucket by days past due (negative or zero = current). */
export function agingBucket(dueAt: string | null | undefined, now: number): AgingBucket {
  if (!dueAt) return "current";
  const due = new Date(dueAt).getTime();
  if (Number.isNaN(due)) return "current";
  const days = Math.floor((now - due) / 86_400_000);
  if (days <= 0) return "current";
  if (days <= 30) return "d1_30";
  if (days <= 60) return "d31_60";
  if (days <= 90) return "d61_90";
  return "d90_plus";
}

export interface AgingRow {
  supplier_id: string;
  supplier_name: string;
  currency: string;
  buckets: Record<AgingBucket, number>;
  total_minor: number;
  bills: number;
}

export function emptyBuckets(): Record<AgingBucket, number> {
  return { current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90_plus: 0 };
}

/** Group open bills (outstanding = total − paid) by supplier + currency into aging buckets. */
export function buildAging(
  bills: ReadonlyArray<{ supplier_id: string; supplier_name: string; currency: string; total_minor: number; paid_minor: number; due_at: string | null }>,
  now: number
): { rows: AgingRow[]; totals: Record<AgingBucket, number>; total_minor: number } {
  const map = new Map<string, AgingRow>();
  const totals = emptyBuckets();
  let total = 0;
  for (const b of bills) {
    const outstanding = Math.max(Number(b.total_minor) - Number(b.paid_minor), 0);
    if (outstanding <= 0) continue;
    const key = `${b.supplier_id}:${b.currency}`;
    const row = map.get(key) ?? { supplier_id: b.supplier_id, supplier_name: b.supplier_name, currency: b.currency, buckets: emptyBuckets(), total_minor: 0, bills: 0 };
    const bucket = agingBucket(b.due_at, now);
    row.buckets[bucket] += outstanding;
    row.total_minor += outstanding;
    row.bills += 1;
    totals[bucket] += outstanding;
    total += outstanding;
    map.set(key, row);
  }
  const rows = [...map.values()].sort((a, b) => b.total_minor - a.total_minor || a.supplier_name.localeCompare(b.supplier_name));
  return { rows, totals, total_minor: total };
}

/** Bill status from paid vs total; draft/void never change. */
export function deriveBillStatus(b: { status: BillStatus; total_minor: number; paid_minor: number }): BillStatus {
  if (b.status === "draft" || b.status === "void") return b.status;
  if (b.total_minor > 0 && b.paid_minor >= b.total_minor) return "paid";
  if (b.paid_minor > 0) return "partially_paid";
  return "open";
}

export function isBillOverdue(b: { status: BillStatus; due_at: string | null }, now = Date.now()): boolean {
  if (b.status !== "open" && b.status !== "partially_paid") return false;
  return Boolean(b.due_at && new Date(b.due_at).getTime() < now);
}

/**
 * Order enough to get back to twice the reorder point (a simple min/max
 * policy), never less than one unit.
 */
export function suggestReorderQty(p: { stock_on_hand: number; stock_reserved: number; reorder_point: number }): number {
  const available = Number(p.stock_on_hand) - Number(p.stock_reserved);
  const target = Math.max(Number(p.reorder_point) * 2, 1);
  return Math.max(target - available, 1);
}

export interface ReorderSuggestion {
  product_id: string;
  name: string;
  sku: string | null;
  stock_available: number;
  reorder_point: number;
  suggested_qty: number;
  unit_cost_minor: number;
  currency: string;
  preferred_supplier_id: string | null;
  supplier_name: string | null;
}

export interface ReorderGroup {
  supplier_id: string | null;
  supplier_name: string | null;
  currency: string;
  lines: ReorderSuggestion[];
  total_minor: number;
}

/** One group per (supplier, currency); products without a preferred supplier land in a null group. */
export function groupBySupplier(suggestions: ReadonlyArray<ReorderSuggestion>): ReorderGroup[] {
  const map = new Map<string, ReorderGroup>();
  for (const s of suggestions) {
    const key = `${s.preferred_supplier_id ?? ""}:${s.currency}`;
    const g = map.get(key) ?? { supplier_id: s.preferred_supplier_id, supplier_name: s.supplier_name, currency: s.currency, lines: [], total_minor: 0 };
    g.lines.push(s);
    g.total_minor += s.suggested_qty * s.unit_cost_minor;
    map.set(key, g);
  }
  return [...map.values()].sort((a, b) => {
    if ((a.supplier_id === null) !== (b.supplier_id === null)) return a.supplier_id === null ? 1 : -1;
    return (a.supplier_name ?? "").localeCompare(b.supplier_name ?? "");
  });
}
