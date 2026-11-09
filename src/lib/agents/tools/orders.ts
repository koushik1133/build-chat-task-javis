import { z } from "zod";
import { registerTool } from "@/lib/agents/registry";
import type { ToolResult } from "@/lib/agents/types";
import { formatMoney } from "@/lib/money/items";
import { listStorefrontProducts } from "@/lib/storefront/catalog";
import { fulfillOrder, getOrder, listOrders } from "@/lib/storefront/orders";
import { ORDER_STATUSES } from "@/lib/storefront/pure";
import { getStorefront } from "@/lib/storefront/settings";

/** Storefront tools: list orders, fulfil a paid order, read the public catalog. Scoped to ctx.userId (org data id). */

function fail(error: string): ToolResult {
  return { ok: false, summary: error, error };
}
function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/* ---------- orders.list ---------- */
const ListInput = z.object({
  status: z.enum(ORDER_STATUSES).optional(),
  q: z.string().max(100).optional(),
  limit: z.number().int().min(1).max(100).optional(),
});
registerTool<z.infer<typeof ListInput>>({
  name: "orders.list",
  module: "orders",
  description: "List storefront orders, newest first, optionally filtered by status (pending_payment, paid, fulfilled, cancelled, refunded) or by order number / customer. Use before orders.fulfil.",
  input: ListInput,
  parameters: {
    type: "object",
    properties: {
      status: { type: "string", enum: [...ORDER_STATUSES], description: "Filter by status (optional)" },
      q: { type: "string", description: "Order number, customer name or email (optional)" },
      limit: { type: "integer", description: "Max orders (default 20)" },
    },
  },
  scope: "read",
  preview: (i) => `List ${i.status ?? "all"} orders${i.q ? ` matching "${i.q}"` : ""}`,
  async run(ctx, input) {
    try {
      const rows = await listOrders(ctx.userId, { status: input.status ?? null, q: input.q ?? null, limit: input.limit ?? 20 });
      return {
        ok: true,
        summary: `${rows.length} order${rows.length === 1 ? "" : "s"}${input.status ? ` (${input.status})` : ""}`,
        data: {
          orders: rows.map((o) => ({
            id: o.id,
            number: o.number,
            status: o.status,
            customer_name: o.customer_name,
            customer_email: o.customer_email,
            total: formatMoney(o.total_minor, o.currency),
            total_minor: o.total_minor,
            currency: o.currency,
            lines: o.items.length,
            shipping: o.shipping_address ? "ship" : "pickup",
            created_at: o.created_at,
            paid_at: o.paid_at,
          })),
        },
      };
    } catch (err) {
      return fail(errMsg(err));
    }
  },
});

/* ---------- orders.fulfil ---------- */
const FulfilInput = z.object({ order_id: z.string().min(1).max(100) });
registerTool<z.infer<typeof FulfilInput>>({
  name: "orders.fulfil",
  module: "orders",
  description: "Mark a paid storefront order as fulfilled (dispatched or ready for collection). Emails the customer. Only paid orders qualify.",
  input: FulfilInput,
  parameters: { type: "object", properties: { order_id: { type: "string", description: "Order id from orders.list" } }, required: ["order_id"] },
  scope: "write",
  requiresApproval: true,
  preview: (i) => `Fulfil order ${i.order_id}`,
  async run(ctx, input) {
    try {
      const existing = await getOrder(ctx.userId, input.order_id);
      if (!existing) return fail("Order not found");
      if (existing.status !== "paid") return fail(`Order ${existing.number} is ${existing.status_label.toLowerCase()}; only paid orders can be fulfilled`);
      const o = await fulfillOrder(ctx.userId, input.order_id, ctx.agentId ? `agent:${ctx.agentId}` : ctx.runId);
      return { ok: true, summary: `Order ${o.number} fulfilled; ${o.customer_email} notified`, data: { id: o.id, number: o.number, status: o.status, fulfilled_at: o.fulfilled_at } };
    } catch (err) {
      return fail(errMsg(err));
    }
  },
});

/* ---------- storefront.catalog ---------- */
const CatalogInput = z.object({ visible_only: z.boolean().optional() });
registerTool<z.infer<typeof CatalogInput>>({
  name: "storefront.catalog",
  module: "storefront",
  description: "The public storefront: whether it is enabled, its URL, and the products listed with price and stock availability.",
  input: CatalogInput,
  parameters: { type: "object", properties: { visible_only: { type: "boolean", description: "Only products shown to shoppers (default true)" } } },
  scope: "read",
  preview: () => "Read storefront catalog",
  async run(ctx, input) {
    try {
      const [sf, products] = await Promise.all([getStorefront(ctx.userId), listStorefrontProducts(ctx.userId)]);
      const rows = (input.visible_only ?? true) ? products.filter((p) => p.visible) : products;
      return {
        ok: true,
        summary: `Storefront ${sf.enabled ? "enabled" : "disabled"} at /shop/${sf.slug}: ${rows.length} product${rows.length === 1 ? "" : "s"} listed`,
        data: {
          storefront: { enabled: sf.enabled, slug: sf.slug, title: sf.title, currency: sf.currency, collect_shipping: sf.collect_shipping, shipping_flat_minor: sf.shipping_flat_minor, pickup_enabled: sf.pickup_enabled },
          products: rows.map((p) => ({
            id: p.id,
            name: p.name,
            sku: p.sku,
            price: formatMoney(p.unit_price_minor, p.currency),
            price_minor: p.unit_price_minor,
            visible: p.visible,
            in_stock: !p.track_stock || p.stock_available > 0,
            stock_available: p.track_stock ? p.stock_available : null,
            low_stock: p.low_stock,
          })),
        },
      };
    } catch (err) {
      return fail(errMsg(err));
    }
  },
});
