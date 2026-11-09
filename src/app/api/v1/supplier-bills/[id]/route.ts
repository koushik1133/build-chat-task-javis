import { getSupplierBill } from "@/lib/procurement/bills";
import { ROUTES } from "@/lib/public-api/registry";
import { op, mustFind } from "@/lib/public-api/handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = op(ROUTES.getSupplierBill, async ({ principal, params }) => ({ data: mustFind(await getSupplierBill(principal.dataId, params.id), "Supplier bill") }));
