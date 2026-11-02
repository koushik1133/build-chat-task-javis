import { adjustStock } from "@/lib/inventory/stock";
import { ROUTES } from "@/lib/public-api/registry";
import { op } from "@/lib/public-api/handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = op(ROUTES.adjustStock, async ({ principal, params, body }) => ({
  data: await adjustStock(principal.dataId, params.id, { kind: body.kind, qty: body.qty, note: body.note ?? null, ref_kind: "api" }, `api_key:${principal.keyId}`),
}));
