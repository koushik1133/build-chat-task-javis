import { updateChangeOrder } from "@/lib/finance/change-orders";
import { ROUTES } from "@/lib/public-api/registry";
import { op, libCall } from "@/lib/public-api/handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = op(ROUTES.setChangeOrderStatus, async ({ principal, params, body }) => {
  const r = await libCall(() => updateChangeOrder(principal.dataId, params.id, { status: body.status }));
  return { data: { change_order: r.change_order, invoice: r.invoice ?? null } };
});
