import { getProduct, updateProduct } from "@/lib/inventory/products";
import { ROUTES } from "@/lib/public-api/registry";
import { op, mustFind } from "@/lib/public-api/handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = op(ROUTES.getProduct, async ({ principal, params }) => ({ data: mustFind(await getProduct(principal.dataId, params.id), "Product") }));

export const PATCH = op(ROUTES.updateProduct, async ({ principal, params, body }) => ({ data: await updateProduct(principal.dataId, params.id, body) }));
