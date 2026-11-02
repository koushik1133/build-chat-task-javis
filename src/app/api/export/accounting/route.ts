import { NextResponse, type NextRequest } from "next/server";
import { requireScope } from "@/lib/auth/scope";
import { dateParam, financeErrorResponse } from "@/lib/finance/http";
import { ACCOUNTING_ENTITIES, AccountingNotConfiguredError, describeAccountingProviders, getAccountingProvider, type AccountingEntity } from "@/lib/accounting";

export const runtime = "nodejs";

/** GET /api/export/accounting?entity=invoices|expenses|payments&from=&to=&provider= → file download. No entity → provider status. */
export async function GET(req: NextRequest) {
  try {
    const scope = await requireScope({ area: "reports" });
    const sp = req.nextUrl.searchParams;
    const entity = sp.get("entity");
    if (!entity) return NextResponse.json({ providers: describeAccountingProviders() });
    if (!(ACCOUNTING_ENTITIES as readonly string[]).includes(entity)) {
      return NextResponse.json({ error: "invalid_entity", detail: `entity must be one of ${ACCOUNTING_ENTITIES.join(", ")}` }, { status: 400 });
    }
    const provider = getAccountingProvider(sp.get("provider"));
    const range = { from: dateParam(req, "from"), to: dateParam(req, "to") };
    const fn = { invoices: provider.exportInvoices, expenses: provider.exportExpenses, payments: provider.exportPayments }[entity as AccountingEntity];
    const file = await fn.call(provider, scope.dataId, range);
    return new NextResponse(file.body, {
      status: 200,
      headers: {
        "Content-Type": file.contentType,
        "Content-Disposition": `attachment; filename="${file.filename}"`,
        "X-Export-Rows": String(file.rows),
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    if (err instanceof AccountingNotConfiguredError) {
      return NextResponse.json({ error: "provider_not_configured", detail: err.message }, { status: 501 });
    }
    return financeErrorResponse(err, "export.accounting.GET");
  }
}
