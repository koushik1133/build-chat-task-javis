import { NextResponse } from "next/server";
import { listPlanInvoices } from "@/lib/plans/checkout";
import { planAdminScope, planErrorResponse } from "@/lib/plans/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const a = await planAdminScope();
  if (!a.ok) return a.res;
  try {
    return NextResponse.json({ invoices: await listPlanInvoices(a.scope.dataId) });
  } catch (err) {
    return planErrorResponse(err, "plans.invoices.GET");
  }
}
