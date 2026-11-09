import { NextResponse } from "next/server";
import { requireScope } from "@/lib/auth/scope";
import { financeErrorResponse } from "@/lib/finance/http";
import { apAging } from "@/lib/procurement/bills";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/reports/ap-aging — outstanding supplier bills bucketed by days overdue, per supplier. */
export async function GET() {
  try {
    const scope = await requireScope({ area: "billing" });
    return NextResponse.json({ aging: await apAging(scope.dataId) });
  } catch (err) {
    return financeErrorResponse(err, "reports.ap-aging.GET");
  }
}
