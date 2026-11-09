/**
 * Pure (client-safe) helpers for multi-location stock: allocation across
 * locations, the transfer state machine and stock-count variance math.
 */

export const LOCATION_KINDS = ["store", "warehouse", "van", "virtual"] as const;
export type LocationKind = (typeof LOCATION_KINDS)[number];

/* ── allocation ─────────────────────────────────────────────────────────── */

export interface LocationAvailability {
  location_id: string;
  available: number;
}
export interface AllocationLine {
  product_id: string;
  location_id: string;
  qty: number;
}
export interface Shortage {
  product_id: string;
  requested: number;
  short: number;
}
export interface AllocationPlan {
  allocations: AllocationLine[];
  shortages: Shortage[];
}

/**
 * Fill each requested quantity from the preferred location first, then from
 * the other locations in order of availability (most first, ties by location
 * id so the result is deterministic). Never takes more than a location has.
 */
export function planAllocation(
  ops: ReadonlyArray<{ product_id: string; qty: number }>,
  availability: ReadonlyMap<string, readonly LocationAvailability[]>,
  preferLocationId?: string | null
): AllocationPlan {
  const allocations: AllocationLine[] = [];
  const shortages: Shortage[] = [];
  for (const op of ops) {
    let need = Math.max(0, Math.trunc(op.qty));
    const locs = (availability.get(op.product_id) ?? []).filter((l) => l.available > 0);
    const ordered = [...locs].sort((a, b) => {
      if (preferLocationId) {
        if (a.location_id === preferLocationId && b.location_id !== preferLocationId) return -1;
        if (b.location_id === preferLocationId && a.location_id !== preferLocationId) return 1;
      }
      return b.available - a.available || a.location_id.localeCompare(b.location_id);
    });
    for (const l of ordered) {
      if (need <= 0) break;
      const take = Math.min(need, l.available);
      allocations.push({ product_id: op.product_id, location_id: l.location_id, qty: take });
      need -= take;
    }
    if (need > 0) shortages.push({ product_id: op.product_id, requested: op.qty, short: need });
  }
  return { allocations, shortages };
}

/* ── transfer state machine ─────────────────────────────────────────────── */

export const TRANSFER_STATUSES = ["draft", "in_transit", "received", "cancelled"] as const;
export type TransferStatus = (typeof TRANSFER_STATUSES)[number];
export type TransferAction = "ship" | "receive" | "cancel" | "edit";

const TRANSITIONS: Record<TransferStatus, readonly TransferAction[]> = {
  draft: ["ship", "cancel", "edit"],
  in_transit: ["receive", "cancel"],
  received: [],
  cancelled: [],
};

export function canTransferAct(status: TransferStatus, action: TransferAction): boolean {
  return TRANSITIONS[status].includes(action);
}

export interface TransferLineQty {
  qty: number;
  received_qty: number;
}

export function remainingQty(l: TransferLineQty): number {
  return Math.max(0, l.qty - l.received_qty);
}

/** True once every line has been received in full. */
export function isFullyReceived(lines: readonly TransferLineQty[]): boolean {
  return lines.length > 0 && lines.every((l) => l.received_qty >= l.qty);
}

/** Clamp a requested receipt to what is still outstanding on the line. */
export function clampReceive(l: TransferLineQty, requested: number): number {
  return Math.max(0, Math.min(Math.trunc(requested), remainingQty(l)));
}

/* ── stock counts ───────────────────────────────────────────────────────── */

/** counted − expected, or null while the line is not yet counted. */
export function countVariance(expected: number, counted: number | null | undefined): number | null {
  return counted === null || counted === undefined ? null : Math.trunc(counted) - Math.trunc(expected);
}

export interface CountSummary {
  lines: number;
  counted: number;
  with_variance: number;
  net_variance: number;
  shrinkage: number;
  overage: number;
}

export function summariseCount(lines: ReadonlyArray<{ expected_qty: number; counted_qty: number | null }>): CountSummary {
  const out: CountSummary = { lines: lines.length, counted: 0, with_variance: 0, net_variance: 0, shrinkage: 0, overage: 0 };
  for (const l of lines) {
    const v = countVariance(l.expected_qty, l.counted_qty);
    if (v === null) continue;
    out.counted++;
    if (v !== 0) out.with_variance++;
    out.net_variance += v;
    if (v < 0) out.shrinkage += -v;
    else out.overage += v;
  }
  return out;
}
