import { z } from "zod";
import { query } from "@/lib/dsql";
import { registerTool } from "@/lib/agents/registry";
import type { ToolResult } from "@/lib/agents/types";
import { assertFeature } from "@/lib/plans/enforce";
import { listReturns } from "@/lib/shipping/returns";
import { createShipmentForOrder, getShipment, listShipmentEvents, listShipments } from "@/lib/shipping/shipments";
import { RETURN_STATUSES } from "@/lib/shipping/types";

/** Shipping tools: track a parcel, buy a label (spends money; always approved), read the returns queue. Scoped to ctx.userId (org data id). */

function fail(error: string): ToolResult {
  return { ok: false, summary: error, error };
}
const errMsg = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/* ---------- shipping.track ---------- */
const TrackInput = z.object({ tracking_number: z.string().max(120).optional(), shipment_id: z.string().max(100).optional(), order_number: z.string().max(60).optional() });
registerTool<z.infer<typeof TrackInput>>({
  name: "shipping.track",
  module: "shipping",
  description: "Where is a package? Look up a shipment by tracking number, shipment id or order number and return its status and tracking timeline.",
  input: TrackInput,
  parameters: { type: "object", properties: { tracking_number: { type: "string" }, shipment_id: { type: "string" }, order_number: { type: "string", description: "e.g. ORD-000012" } } },
  scope: "read",
  preview: (i) => `Track ${i.tracking_number ?? i.shipment_id ?? i.order_number ?? "shipment"}`,
  async run(ctx, input) {
    try {
      let rows = [];
      if (input.shipment_id) {
        const s = await getShipment(ctx.userId, input.shipment_id);
        rows = s ? [s] : [];
      } else if (input.tracking_number) {
        rows = (await listShipments(ctx.userId, { q: input.tracking_number, limit: 5 })).filter((s) => s.tracking_number === input.tracking_number);
      } else if (input.order_number) {
        const o = await query<{ id: string }>(`SELECT id FROM orders WHERE user_id = $1 AND number = $2 LIMIT 1`, [ctx.userId, input.order_number]);
        rows = o[0] ? await listShipments(ctx.userId, { orderId: o[0].id, limit: 10 }) : [];
      } else return fail("Give a tracking_number, shipment_id or order_number");
      if (rows.length === 0) return fail("No shipment found");
      const out = [];
      for (const s of rows) out.push({ id: s.id, status: s.status, carrier: s.carrier, service: s.service, tracking_number: s.tracking_number, delivered_at: s.delivered_at, events: (await listShipmentEvents(ctx.userId, s.id)).map((e) => ({ at: e.occurred_at, status: e.status, description: e.description, location: e.location })) });
      return { ok: true, summary: `${out.length} shipment${out.length === 1 ? "" : "s"}: ${out.map((o) => o.status).join(", ")}`, data: { shipments: out } };
    } catch (err) {
      return fail(errMsg(err));
    }
  },
});

/* ---------- shipping.create_shipment ---------- */
const CreateInput = z.object({
  order_id: z.string().min(1).max(100),
  provider: z.enum(["simulated", "easypost", "shippo"]).optional(),
  rate_id: z.string().max(300).optional(),
  weight_grams: z.number().int().min(1).max(70_000_000).optional(),
});
registerTool<z.infer<typeof CreateInput>>({
  name: "shipping.create_shipment",
  module: "shipping",
  description: "Buy a shipping label for a paid order and create the shipment (SPENDS MONEY on the carrier account). Picks the service the customer chose at checkout, else the cheapest. Always needs approval.",
  input: CreateInput,
  parameters: {
    type: "object",
    properties: {
      order_id: { type: "string", description: "Order id (from orders.list)" },
      provider: { type: "string", enum: ["simulated", "easypost", "shippo"], description: "Carrier provider (default: the connected one)" },
      rate_id: { type: "string", description: "Specific rate id (optional)" },
      weight_grams: { type: "integer", description: "Parcel weight override in grams (optional)" },
    },
    required: ["order_id"],
  },
  scope: "write",
  risk: "high",
  requiresApproval: () => true,
  preview: (i) => `Buy a shipping label for order ${i.order_id}${i.provider ? ` via ${i.provider}` : ""}`,
  async run(ctx, input) {
    try {
      await assertFeature({ dataId: ctx.userId }, "shipping");
      const made = await createShipmentForOrder(ctx.userId, input.order_id, { provider: input.provider, rate_id: input.rate_id, packages: input.weight_grams ? [{ weight_grams: input.weight_grams }] : undefined }, { actorId: null });
      const s = made[0];
      return { ok: true, summary: `Label bought: ${s.carrier ?? "carrier"} ${s.tracking_number ?? ""} (${(s.rate_minor / 100).toFixed(2)} ${s.currency})`, data: { shipments: made.map((m) => ({ id: m.id, tracking_number: m.tracking_number, carrier: m.carrier, service: m.service, rate_minor: m.rate_minor, currency: m.currency })) } };
    } catch (err) {
      return fail(errMsg(err));
    }
  },
});

/* ---------- shipping.returns ---------- */
const ReturnsInput = z.object({ status: z.enum(RETURN_STATUSES).optional(), limit: z.number().int().min(1).max(100).optional() });
registerTool<z.infer<typeof ReturnsInput>>({
  name: "shipping.returns",
  module: "shipping",
  description: "List customer return requests (newest first), optionally by status: requested, approved, rejected, label_sent, received, refunded, closed.",
  input: ReturnsInput,
  parameters: { type: "object", properties: { status: { type: "string", enum: [...RETURN_STATUSES] }, limit: { type: "integer" } } },
  scope: "read",
  preview: (i) => `List ${i.status ?? "all"} returns`,
  async run(ctx, input) {
    try {
      const rows = await listReturns(ctx.userId, { status: input.status ?? null, limit: input.limit ?? 20 });
      return { ok: true, summary: `${rows.length} return${rows.length === 1 ? "" : "s"}`, data: { returns: rows.map((r) => ({ id: r.id, order: r.order_number, status: r.status, reason: r.reason, resolution: r.resolution, items: r.items, refund_minor: r.refund_minor, created_at: r.created_at })) } };
    } catch (err) {
      return fail(errMsg(err));
    }
  },
});
