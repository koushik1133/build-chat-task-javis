import { z } from "zod";
import { registerTool } from "@/lib/agents/registry";
import type { ToolResult } from "@/lib/agents/types";
import { formatMoney } from "@/lib/money/items";
import { apAging } from "@/lib/procurement/bills";
import { createPurchaseOrder } from "@/lib/procurement/purchase-orders";
import { AGING_BUCKET_LABELS, AGING_BUCKETS } from "@/lib/procurement/pure";
import { reorderSuggestions } from "@/lib/procurement/reorder";
import { getSupplier, listSuppliers } from "@/lib/procurement/suppliers";

/** Procurement tools: reorder suggestions, draft purchase orders, AP aging. Scoped to ctx.userId (org data id). */

function fail(error: string): ToolResult {
  return { ok: false, summary: error, error };
}
function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
const actor = (ctx: { agentId: string | null; runId: string }) => (ctx.agentId ? `agent:${ctx.agentId}` : ctx.runId);

/* ---------- procurement.reorder_suggestions ---------- */
const ReorderInput = z.object({ limit: z.number().int().min(1).max(200).optional() });
registerTool<z.infer<typeof ReorderInput>>({
  name: "procurement.reorder_suggestions",
  module: "procurement",
  description: "Products at or below their reorder point with a suggested order quantity, grouped by preferred supplier. Use before procurement.create_po.",
  input: ReorderInput,
  parameters: { type: "object", properties: { limit: { type: "integer", description: "Max products (default 50)" } } },
  scope: "read",
  preview: () => "List reorder suggestions",
  async run(ctx, input) {
    try {
      const { suggestions, groups } = await reorderSuggestions(ctx.userId, input.limit ?? 50);
      const unassigned = groups.find((g) => g.supplier_id === null)?.lines.length ?? 0;
      return {
        ok: true,
        summary: suggestions.length === 0 ? "Nothing is below its reorder point." : `${suggestions.length} product${suggestions.length === 1 ? "" : "s"} to reorder across ${groups.length} supplier group${groups.length === 1 ? "" : "s"}${unassigned ? ` (${unassigned} without a preferred supplier)` : ""}`,
        data: {
          groups: groups.map((g) => ({
            supplier_id: g.supplier_id,
            supplier_name: g.supplier_name,
            currency: g.currency,
            total: formatMoney(g.total_minor, g.currency),
            lines: g.lines.map((l) => ({ product_id: l.product_id, name: l.name, sku: l.sku, available: l.stock_available, reorder_point: l.reorder_point, suggested_qty: l.suggested_qty, unit_cost_minor: l.unit_cost_minor })),
          })),
        },
      };
    } catch (err) {
      return fail(errMsg(err));
    }
  },
});

/* ---------- procurement.create_po ---------- */
const CreatePoInput = z.object({
  supplier: z.string().min(1).max(200).describe("Supplier id or exact name"),
  items: z
    .array(
      z.object({
        description: z.string().min(1).max(500),
        qty: z.number().positive().max(1_000_000),
        unit_cost_minor: z.number().int().min(0).max(1_000_000_000_000),
        product_id: z.string().max(100).optional(),
      })
    )
    .min(1)
    .max(100),
  currency: z.string().length(3).optional(),
  expected_at: z.string().max(40).optional(),
  notes: z.string().max(2000).optional(),
});
registerTool<z.infer<typeof CreatePoInput>>({
  name: "procurement.create_po",
  module: "procurement",
  description: "Create a draft purchase order for a supplier. Link lines to products (product_id) so receiving updates stock and cost. The order is not sent.",
  input: CreatePoInput,
  parameters: {
    type: "object",
    properties: {
      supplier: { type: "string", description: "Supplier id or exact name" },
      items: {
        type: "array",
        items: {
          type: "object",
          properties: {
            description: { type: "string" },
            qty: { type: "number" },
            unit_cost_minor: { type: "integer", description: "Unit cost in minor units (cents)" },
            product_id: { type: "string", description: "Pricebook product id (optional, enables receiving into stock)" },
          },
          required: ["description", "qty", "unit_cost_minor"],
        },
      },
      currency: { type: "string", description: "ISO 4217; defaults to the supplier's currency" },
      expected_at: { type: "string", description: "ISO date the goods are expected" },
      notes: { type: "string" },
    },
    required: ["supplier", "items"],
  },
  scope: "write",
  requiresApproval: true,
  preview: (i) => `Draft PO for ${i.supplier}: ${i.items.length} line${i.items.length === 1 ? "" : "s"}`,
  async run(ctx, input) {
    try {
      let supplier = await getSupplier(ctx.userId, input.supplier);
      if (!supplier) {
        const matches = (await listSuppliers(ctx.userId, { q: input.supplier, limit: 5 })).filter((s) => s.name.toLowerCase() === input.supplier.toLowerCase());
        supplier = matches[0] ?? null;
      }
      if (!supplier) return fail(`Supplier "${input.supplier}" not found. Create it under Procurement → Suppliers first.`);
      const expected = input.expected_at ? new Date(input.expected_at) : null;
      if (expected && Number.isNaN(expected.getTime())) return fail("expected_at must be an ISO date");
      const po = await createPurchaseOrder(
        ctx.userId,
        {
          supplier_id: supplier.id,
          currency: input.currency?.toUpperCase(),
          items: input.items.map((it) => ({ description: it.description, qty: it.qty, unit_minor: it.unit_cost_minor, tax_rate_bp: 0, product_id: it.product_id })),
          expected_at: expected ? expected.toISOString() : null,
          notes: input.notes ?? null,
        },
        actor(ctx)
      );
      return { ok: true, summary: `Drafted ${po.number} for ${supplier.name}: ${formatMoney(po.total_minor, po.currency)}`, data: { id: po.id, number: po.number, status: po.status, total_minor: po.total_minor, currency: po.currency, supplier_id: supplier.id } };
    } catch (err) {
      return fail(`Could not create the purchase order: ${errMsg(err)}`);
    }
  },
});

/* ---------- procurement.ap_aging ---------- */
const AgingInput = z.object({});
registerTool<z.infer<typeof AgingInput>>({
  name: "procurement.ap_aging",
  module: "procurement",
  description: "Accounts-payable aging: what is owed to each supplier, bucketed by days overdue (current, 1–30, 31–60, 61–90, 90+).",
  input: AgingInput,
  parameters: { type: "object", properties: {} },
  scope: "read",
  preview: () => "AP aging report",
  async run(ctx) {
    try {
      const a = await apAging(ctx.userId);
      const cur = a.currencies[0] ?? "USD";
      const mixed = a.currencies.length > 1;
      return {
        ok: true,
        summary: a.rows.length === 0 ? "No open supplier bills." : `${formatMoney(a.total_minor, cur)}${mixed ? " (mixed currencies)" : ""} owed across ${a.rows.length} supplier${a.rows.length === 1 ? "" : "s"}; ${formatMoney(a.totals.d1_30 + a.totals.d31_60 + a.totals.d61_90 + a.totals.d90_plus, cur)} overdue`,
        data: {
          as_of: a.as_of,
          buckets: AGING_BUCKETS.map((b) => ({ bucket: b, label: AGING_BUCKET_LABELS[b], total_minor: a.totals[b] })),
          suppliers: a.rows.map((r) => ({ supplier_id: r.supplier_id, supplier_name: r.supplier_name, currency: r.currency, total_minor: r.total_minor, bills: r.bills, ...r.buckets })),
        },
      };
    } catch (err) {
      return fail(errMsg(err));
    }
  },
});
