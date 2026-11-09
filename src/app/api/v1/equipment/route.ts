import { listCheckouts } from "@/lib/inventory/stock";
import { ROUTES } from "@/lib/public-api/registry";
import { op, singlePage } from "@/lib/public-api/handler";
import { checkoutView } from "@/lib/public-api/views";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = op(ROUTES.listEquipment, async ({ principal, query, list }) =>
  singlePage((await listCheckouts(principal.dataId, { open: query.open === "true", limit: list.limit })).map(checkoutView))
);
