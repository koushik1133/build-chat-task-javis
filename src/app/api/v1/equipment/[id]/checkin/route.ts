import { checkinEquipment } from "@/lib/inventory/stock";
import { ROUTES } from "@/lib/public-api/registry";
import { op, libCall } from "@/lib/public-api/handler";
import { checkoutView } from "@/lib/public-api/views";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = op(ROUTES.checkinEquipment, async ({ principal, params }) => ({
  data: checkoutView(await libCall(() => checkinEquipment(principal.dataId, params.id, `api_key:${principal.keyId}`))),
}));
