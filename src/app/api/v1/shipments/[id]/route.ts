import { ROUTES } from "@/lib/public-api/registry";
import { mustFind, op } from "@/lib/public-api/handler";
import { getShipment } from "@/lib/shipping/shipments";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = op(ROUTES.getShipment, async ({ principal, params }) => ({ data: mustFind(await getShipment(principal.dataId, params.id), "Shipment") }));
