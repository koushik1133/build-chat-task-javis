import { getSupplier, updateSupplier } from "@/lib/procurement/suppliers";
import { ROUTES } from "@/lib/public-api/registry";
import { op, libCall, mustFind } from "@/lib/public-api/handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = op(ROUTES.getSupplier, async ({ principal, params }) => ({ data: mustFind(await getSupplier(principal.dataId, params.id), "Supplier") }));

export const PATCH = op(ROUTES.updateSupplier, async ({ principal, params, body }) => {
  mustFind(await getSupplier(principal.dataId, params.id), "Supplier");
  return { data: await libCall(() => updateSupplier(principal.dataId, params.id, body)) };
});
