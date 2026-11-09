import { z } from "zod";
import { registerTool } from "@/lib/agents/registry";
import type { ToolResult } from "@/lib/agents/types";
import { getProduct } from "@/lib/inventory/products";
import { listLocations, type LocationDTO } from "@/lib/inventory/locations";
import { listLevels } from "@/lib/inventory/levels";
import { createTransfer, receiveTransfer, shipTransfer } from "@/lib/inventory/transfers";
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

/* ---------- inventory.locations ---------- */
const LocationsInput = z.object({ include_inactive: z.boolean().optional() });
registerTool<z.infer<typeof LocationsInput>>({
  name: "inventory.locations",
  module: "inventory",
  description: "List stock locations (warehouses, stores, vans) with their ids and which one is the default.",
  input: LocationsInput,
  parameters: { type: "object", properties: { include_inactive: { type: "boolean" } } },
  scope: "read",
  preview: () => "List stock locations",
  async run(ctx, input) {
    try {
      const rows = await listLocations(ctx.userId, { includeInactive: input.include_inactive ?? false });
      return { ok: true, data: rows.map((l) => ({ id: l.id, name: l.name, code: l.code, kind: l.kind, is_default: l.is_default, active: l.active })), summary: `${rows.length} location(s)` };
    } catch (err) {
      return fail(`List failed: ${errMsg(err)}`);
    }
  },
});

/* ---------- inventory.levels ---------- */
const LevelsInput = z.object({ product_id: z.string().max(100).optional(), location_id: z.string().max(100).optional(), limit: z.number().int().min(1).max(200).optional() });
registerTool<z.infer<typeof LevelsInput>>({
  name: "inventory.levels",
  module: "inventory",
  description: "Stock on hand / reserved / available per product and location. Filter by product_id or location_id.",
  input: LevelsInput,
  parameters: { type: "object", properties: { product_id: { type: "string" }, location_id: { type: "string" }, limit: { type: "integer" } } },
  scope: "read",
  preview: () => "Read stock levels by location",
  async run(ctx, input) {
    try {
      const rows = (await listLevels(ctx.userId, { productId: input.product_id ?? null, locationId: input.location_id ?? null })).slice(0, input.limit ?? 50);
      return { ok: true, data: rows.map((r) => ({ product: r.product_name, sku: r.product_sku, location: r.location_name, on_hand: r.on_hand, reserved: r.reserved, available: r.available, low: r.low })), summary: `${rows.length} level row(s)` };
    } catch (err) {
      return fail(`Levels failed: ${errMsg(err)}`);
    }
  },
});

/* ---------- inventory.transfer_stock ---------- */
const TransferInput = z.object({
  product_id: z.string().min(1).max(100),
  qty: z.number().int().min(1).max(1_000_000),
  from_location: z.string().min(1).max(100).describe("Location id, name or code"),
  to_location: z.string().min(1).max(100).describe("Location id, name or code"),
  receive_now: z.boolean().optional().describe("Also receive at the destination straight away"),
  note: z.string().max(500).optional(),
});
function pickLocation(all: LocationDTO[], ref: string): LocationDTO | null {
  const r = ref.trim().toLowerCase();
  return all.find((l) => l.id === ref) ?? all.find((l) => l.code?.toLowerCase() === r) ?? all.find((l) => l.name.toLowerCase() === r) ?? null;
}
registerTool<z.infer<typeof TransferInput>>({
  name: "inventory.transfer_stock",
  module: "inventory",
  description: "Move stock of a product from one location to another (creates the transfer and ships it; optionally receives it immediately).",
  input: TransferInput,
  parameters: {
    type: "object",
    properties: {
      product_id: { type: "string" },
      qty: { type: "integer" },
      from_location: { type: "string", description: "Location id, name or code" },
      to_location: { type: "string", description: "Location id, name or code" },
      receive_now: { type: "boolean" },
      note: { type: "string" },
    },
    required: ["product_id", "qty", "from_location", "to_location"],
  },
  scope: "write",
  requiresApproval: true,
  risk: "medium",
  preview: (i) => `Transfer ${i.qty} × ${i.product_id} from ${i.from_location} to ${i.to_location}${i.receive_now ? " (receive immediately)" : ""}`,
  async run(ctx, input) {
    try {
      const all = await listLocations(ctx.userId);
      const from = pickLocation(all, input.from_location);
      const to = pickLocation(all, input.to_location);
      if (!from) return fail(`Location not found: ${input.from_location}`);
      if (!to) return fail(`Location not found: ${input.to_location}`);
      let t = await createTransfer(ctx.userId, { from_location_id: from.id, to_location_id: to.id, lines: [{ product_id: input.product_id, qty: input.qty }], note: input.note ?? null }, actor(ctx));
      t = await shipTransfer(ctx.userId, t.id, actor(ctx));
      if (input.receive_now) t = await receiveTransfer(ctx.userId, t.id, {}, actor(ctx));
      return { ok: true, data: { id: t.id, number: t.number, status: t.status }, summary: `${t.number}: ${input.qty} moved ${from.name} → ${to.name} (${t.status.replace("_", " ")})` };
    } catch (err) {
      if (isInsufficientStock(err)) return fail(`Not enough stock at the source: ${errMsg(err)}`);
      return fail(`Transfer failed: ${errMsg(err)}`);
    }
  },
});
