import { z } from "zod";
import { registerTool } from "@/lib/agents/registry";
import type { ToolResult } from "@/lib/agents/types";
import { getProduct } from "@/lib/inventory/products";
import { adjustStock, checkinEquipment, checkoutEquipment, isInsufficientStock, listCheckouts } from "@/lib/inventory/stock";

/** Inventory tools: stock adjustments and equipment checkouts (products.search / products.low_stock live in finance.ts). */

function fail(error: string): ToolResult {
  return { ok: false, summary: error, error };
}
function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
const actor = (ctx: { agentId: string | null; runId: string }) => (ctx.agentId ? `agent:${ctx.agentId}` : ctx.runId);

/* ---------- inventory.adjust_stock ---------- */
const AdjustInput = z.object({
  product_id: z.string().min(1).max(100),
  kind: z.enum(["receive", "consume", "adjust"]),
  qty: z.number().int().min(-1_000_000).max(1_000_000).describe("receive/consume: positive; adjust: signed delta"),
  note: z.string().max(500).optional(),
});
registerTool<z.infer<typeof AdjustInput>>({
  name: "inventory.adjust_stock",
  module: "inventory",
  description: "Receive, consume or correct stock for a product. Every change is written to the stock ledger.",
  input: AdjustInput,
  parameters: {
    type: "object",
    properties: {
      product_id: { type: "string" },
      kind: { type: "string", enum: ["receive", "consume", "adjust"] },
      qty: { type: "integer", description: "receive/consume: positive; adjust: signed delta" },
      note: { type: "string" },
    },
    required: ["product_id", "kind", "qty"],
  },
  scope: "write",
  requiresApproval: (i) => i.kind !== "receive",
  preview: (i) => `${i.kind} ${i.qty} × product ${i.product_id}${i.note ? ` (${i.note})` : ""}`,
  async run(ctx, input) {
    try {
      if (!(await getProduct(ctx.userId, input.product_id))) return fail("Product not found");
      const p = await adjustStock(ctx.userId, input.product_id, { kind: input.kind, qty: input.qty, note: input.note ?? null }, actor(ctx));
      return { ok: true, data: { id: p.id, name: p.name, sku: p.sku, stock_on_hand: p.stock_on_hand, stock_reserved: p.stock_reserved }, summary: `${p.name}: now ${p.stock_on_hand} on hand` };
    } catch (err) {
      if (isInsufficientStock(err)) return fail(`Not enough stock: ${errMsg(err)}`);
      return fail(`Stock change failed: ${errMsg(err)}`);
    }
  },
});

/* ---------- inventory.checkout ---------- */
const CheckoutInput = z.object({
  product_id: z.string().min(1).max(100),
  qty: z.number().int().min(1).max(100_000).optional(),
  checked_out_to: z.string().max(200).optional(),
  due_back_at: z.string().max(40).optional(),
  ref_kind: z.string().regex(/^[a-z_]+$/).max(40).optional(),
  ref_id: z.string().max(100).optional(),
});
registerTool<z.infer<typeof CheckoutInput>>({
  name: "inventory.checkout",
  module: "inventory",
  description: "Check equipment out to a person or job; reserves the quantity so it cannot be double-booked.",
  input: CheckoutInput,
  parameters: {
    type: "object",
    properties: {
      product_id: { type: "string" },
      qty: { type: "integer", description: "Default 1" },
      checked_out_to: { type: "string" },
      due_back_at: { type: "string", description: "ISO date it is due back" },
      ref_kind: { type: "string", description: "e.g. record, quote" },
      ref_id: { type: "string" },
    },
    required: ["product_id"],
  },
  scope: "write",
  requiresApproval: false,
  preview: (i) => `Check out ${i.qty ?? 1} × ${i.product_id}${i.checked_out_to ? ` to ${i.checked_out_to}` : ""}`,
  async run(ctx, input) {
    try {
      const c = await checkoutEquipment(ctx.userId, { product_id: input.product_id, qty: input.qty ?? 1, checked_out_to: input.checked_out_to ?? null, due_back_at: input.due_back_at ?? null, ref_kind: input.ref_kind ?? null, ref_id: input.ref_id ?? null }, actor(ctx));
      return { ok: true, data: { id: c.id, product_name: c.product_name, qty: c.qty, checked_out_to: c.checked_out_to, due_back_at: c.due_back_at }, summary: `Checked out ${c.qty} × ${c.product_name}${c.checked_out_to ? ` to ${c.checked_out_to}` : ""} (checkout ${c.id})` };
    } catch (err) {
      if (isInsufficientStock(err)) return fail(`Not enough available: ${errMsg(err)}`);
      return fail(`Checkout failed: ${errMsg(err)}`);
    }
  },
});

/* ---------- inventory.checkin ---------- */
const CheckinInput = z.object({ checkout_id: z.string().min(1).max(100) });
registerTool<z.infer<typeof CheckinInput>>({
  name: "inventory.checkin",
  module: "inventory",
  description: "Check equipment back in by checkout id (releases the reservation). Use inventory.list_checkouts to find open ones.",
  input: CheckinInput,
  parameters: { type: "object", properties: { checkout_id: { type: "string" } }, required: ["checkout_id"] },
  scope: "write",
  requiresApproval: false,
  preview: (i) => `Check in ${i.checkout_id}`,
  async run(ctx, input) {
    try {
      const c = await checkinEquipment(ctx.userId, input.checkout_id, actor(ctx));
      return { ok: true, data: { id: c.id, product_name: c.product_name, qty: c.qty, returned_at: c.returned_at }, summary: `Checked in ${c.qty} × ${c.product_name}` };
    } catch (err) {
      return fail(`Check-in failed: ${errMsg(err)}`);
    }
  },
});

/* ---------- inventory.list_checkouts ---------- */
const ListCheckoutsInput = z.object({ open_only: z.boolean().optional(), limit: z.number().int().min(1).max(200).optional() });
registerTool<z.infer<typeof ListCheckoutsInput>>({
  name: "inventory.list_checkouts",
  module: "inventory",
  description: "List equipment checkouts (open ones first, overdue flagged).",
  input: ListCheckoutsInput,
  parameters: { type: "object", properties: { open_only: { type: "boolean" }, limit: { type: "integer" } } },
  scope: "read",
  preview: (i) => `List ${i.open_only ? "open " : ""}checkouts`,
  async run(ctx, input) {
    try {
      const rows = await listCheckouts(ctx.userId, { open: input.open_only ?? true, limit: input.limit ?? 50 });
      const data = rows.map((c) => ({ id: c.id, product_name: c.product_name, qty: c.qty, checked_out_to: c.checked_out_to, due_back_at: c.due_back_at, returned_at: c.returned_at, overdue: c.overdue }));
      const overdue = rows.filter((c) => c.overdue).length;
      return { ok: true, data, summary: `${rows.length} checkout(s)${overdue ? `, ${overdue} overdue` : ""}` };
    } catch (err) {
      return fail(`List failed: ${errMsg(err)}`);
    }
  },
});
