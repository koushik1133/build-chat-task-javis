import { getInvoice, recordPayment } from "@/lib/money/invoices";
import { ROUTES } from "@/lib/public-api/registry";
import { op, mustFind } from "@/lib/public-api/handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = op(ROUTES.recordPayment, async ({ principal, params, body }) => {
  const inv = mustFind(await getInvoice(principal.dataId, params.id), "Invoice");
  const res = await recordPayment({
    invoiceId: inv.id,
    provider: body.provider ?? "manual",
    providerRef: body.reference ?? null,
    amountMinor: body.amount_minor,
    currency: body.currency ?? inv.currency,
    status: "succeeded",
  });
  const after = await getInvoice(principal.dataId, params.id);
  return { data: { invoice: after ?? inv, duplicate: res.duplicate }, status: res.duplicate ? 200 : 201 };
});
