import { NextResponse, type NextRequest } from "next/server";
import { recordAudit } from "@/lib/audit";
import { workforceError, workforceScope } from "@/lib/workforce/http";
import { payrollCsv, payrollExport } from "@/lib/workforce/payroll";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/workforce/payroll?from=YYYY-MM-DD&to=YYYY-MM-DD&format=json|csv */
export async function GET(req: NextRequest) {
  const s = await workforceScope(req, false);
  if (!s.ok) return s.res;
  const q = req.nextUrl.searchParams;
  const today = new Date().toISOString().slice(0, 10);
  const from = q.get("from") ?? `${today.slice(0, 8)}01`;
  const to = q.get("to") ?? today;
  try {
    const exp = await payrollExport(s.scope.dataId, { from, to });
    if (q.get("format") === "csv") {
      void recordAudit(s.scope, { action: "export", entity: "payroll", after: { from, to, lines: exp.lines.length }, req }).catch(() => undefined);
      return new NextResponse(payrollCsv(exp), {
        headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="payroll-${from}-to-${to}.csv"`, "Cache-Control": "no-store" },
      });
    }
    return NextResponse.json(exp);
  } catch (err) {
    return workforceError(err, "workforce.payroll");
  }
}
