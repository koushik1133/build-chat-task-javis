import { sendInvoice } from "@/lib/money/invoices";
import { ROUTES } from "@/lib/public-api/registry";
import { op } from "@/lib/public-api/handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = op(ROUTES.sendInvoice, async ({ principal, params, body }) => {
  const { invoice, url, path } = await sendInvoice(principal.dataId, params.id, { to: body.to ?? null, message: body.message ?? null });
  return { data: { ...invoice, share: { url, path } } };
});
