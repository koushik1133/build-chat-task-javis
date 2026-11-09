import { query } from "@/lib/dsql";
import { createPurchaseOrder, type PurchaseOrderDTO } from "./purchase-orders";
import { groupBySupplier, suggestReorderQty, type ReorderGroup, type ReorderSuggestion } from "./pure";

/**
 * Reorder suggestions: tracked products at or below their reorder point,
 * grouped by preferred supplier. "Create POs" turns each supplier group into a
 * draft purchase order; products without a preferred supplier are skipped
 * (the UI asks the user to assign one).
 */

interface LowRow {
  id: string;
  name: string;
  sku: string | null;
  stock_on_hand: number | string;
  stock_reserved: number | string;
  reorder_point: number | string;
  cost_minor: number | string;
  last_cost_minor: number | string | null;
  currency: string;
  preferred_supplier_id: string | null;
  supplier_name: string | null;
}

export async function reorderSuggestions(dataId: string, limit = 200): Promise<{ suggestions: ReorderSuggestion[]; groups: ReorderGroup[] }> {
  const rows = await query<LowRow>(
    `SELECT p.id, p.name, p.sku, p.stock_on_hand, p.stock_reserved, p.reorder_point, p.cost_minor, p.last_cost_minor, p.currency,
            p.preferred_supplier_id, s.name AS supplier_name
       FROM products p LEFT JOIN suppliers s ON s.id = p.preferred_supplier_id AND s.deleted_at IS NULL
      WHERE p.user_id = $1 AND p.deleted_at IS NULL AND p.active = TRUE AND p.track_stock = TRUE
        AND (p.stock_on_hand - p.stock_reserved) <= p.reorder_point
      ORDER BY (p.stock_on_hand - p.stock_reserved - p.reorder_point) ASC, p.name ASC
      LIMIT $2`,
    [dataId, Math.min(Math.max(limit, 1), 1000)]
  );
  const suggestions: ReorderSuggestion[] = rows.map((r) => {
    const stock = { stock_on_hand: Number(r.stock_on_hand), stock_reserved: Number(r.stock_reserved), reorder_point: Number(r.reorder_point) };
    return {
      product_id: r.id,
      name: r.name,
      sku: r.sku,
      stock_available: stock.stock_on_hand - stock.stock_reserved,
      reorder_point: stock.reorder_point,
      suggested_qty: suggestReorderQty(stock),
      unit_cost_minor: Number(r.last_cost_minor ?? r.cost_minor ?? 0),
      currency: r.currency,
      preferred_supplier_id: r.preferred_supplier_id && r.supplier_name ? r.preferred_supplier_id : null,
      supplier_name: r.supplier_name,
    };
  });
  return { suggestions, groups: groupBySupplier(suggestions) };
}

export interface CreateReorderPosResult {
  created: PurchaseOrderDTO[];
  /** Products skipped because they have no preferred supplier. */
  skipped: ReorderSuggestion[];
}

/** One draft PO per supplier for the current suggestions (optionally only the given products). */
export async function createReorderPurchaseOrders(dataId: string, opts: { productIds?: string[] | null } = {}, actorId?: string | null): Promise<CreateReorderPosResult> {
  const { groups } = await reorderSuggestions(dataId);
  const only = opts.productIds && opts.productIds.length > 0 ? new Set(opts.productIds) : null;
  const created: PurchaseOrderDTO[] = [];
  const skipped: ReorderSuggestion[] = [];
  for (const g of groups) {
    const lines = only ? g.lines.filter((l) => only.has(l.product_id)) : g.lines;
    if (lines.length === 0) continue;
    if (!g.supplier_id) {
      skipped.push(...lines);
      continue;
    }
    const po = await createPurchaseOrder(
      dataId,
      {
        supplier_id: g.supplier_id,
        currency: g.currency,
        items: lines.map((l) => ({ description: l.sku ? `${l.name} (${l.sku})` : l.name, qty: l.suggested_qty, unit_minor: l.unit_cost_minor, tax_rate_bp: 0, product_id: l.product_id })),
        notes: "Created from reorder suggestions",
      },
      actorId
    );
    created.push(po);
  }
  return { created, skipped };
}
