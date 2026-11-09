import { getSupplierBill, recordBillPayment } from "@/lib/procurement/bills";
import { ROUTES } from "@/lib/public-api/registry";
import { op, libCall, mustFind } from "@/lib/public-api/handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = op(ROUTES.paySupplierBill, async ({ principal, params, body }) => {
  mustFind(await getSupplierBill(principal.dataId, params.id), "Supplier bill");
  return { data: await libCall(() => recordBillPayment(principal.dataId, params.id, body, `api_key:${principal.keyId}`)), status: 201 };
});
