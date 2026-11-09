import { checkoutEquipment } from "@/lib/inventory/stock";
import { ROUTES } from "@/lib/public-api/registry";
import { op, libCall } from "@/lib/public-api/handler";
import { checkoutView } from "@/lib/public-api/views";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = op(ROUTES.checkoutEquipment, async ({ principal, body }) => ({
  data: checkoutView(await libCall(() => checkoutEquipment(principal.dataId, body, `api_key:${principal.keyId}`))),
  status: 201,
}));
