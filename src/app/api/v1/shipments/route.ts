import { ROUTES } from "@/lib/public-api/registry";
import { libCall, op } from "@/lib/public-api/handler";
import { page } from "@/lib/public-api/pagination";
import { ApiError } from "@/lib/public-api/envelope";
import { assertFeature, isPlanLimitError } from "@/lib/plans/enforce";
import { createShipmentForOrder, listShipments } from "@/lib/shipping/shipments";
import { ShippingError } from "@/lib/shipping/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = op(ROUTES.listShipments, async ({ principal, query, list }) => {
  const rows = await listShipments(principal.dataId, { status: query.status ?? null, orderId: query.order_id ?? null, q: list.q, cursor: list.cursor, limit: list.limit + 1 });
  const p = page(rows, list.limit, (r) => ({ created_at: r.created_at, id: r.id }));
  return { data: p.data, meta: { next_cursor: p.next_cursor } };
});

export const POST = op(ROUTES.createShipment, async ({ principal, body }) => {
  const { order_id, ...input } = body;
  if (!input.manual) {
    try {
      await assertFeature({ dataId: principal.dataId }, "shipping");
    } catch (err) {
      if (isPlanLimitError(err)) throw ApiError.forbidden(err.message);
      throw err;
    }
  }
  return {
    data: await libCall(async () => {
      try {
        return { shipments: await createShipmentForOrder(principal.dataId, order_id, input, { actorId: `api_key:${principal.keyId}` }) };
      } catch (err) {
        if (err instanceof ShippingError) throw Object.assign(new Error(err.message), { status: err.status });
        throw err;
      }
    }),
  };
});
