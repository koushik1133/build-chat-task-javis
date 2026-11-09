import { ROUTES } from "@/lib/public-api/registry";
import { op } from "@/lib/public-api/handler";
import { listStorefrontProducts, upsertStorefrontProduct } from "@/lib/storefront/catalog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = op(ROUTES.listStorefrontProducts, async ({ principal }) => ({ data: await listStorefrontProducts(principal.dataId), meta: { next_cursor: null } }));

export const PATCH = op(ROUTES.putStorefrontProduct, async ({ principal, body }) => ({ data: await upsertStorefrontProduct(principal.dataId, body) }));
