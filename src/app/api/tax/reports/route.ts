import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireScope } from "@/lib/auth/scope";
import { errorResponse, parseBody } from "@/lib/money/http";
import { planGate } from "@/lib/plans/http";
import { recordAudit } from "@/lib/audit";
import { rateLimitAsync } from "@/lib/request-limits";
import { REGIMES, isRegime } from "@/lib/tax-compliance/regimes";
import { loadReport } from "@/lib/tax-compliance/reports-data";
import { reportToCsv } from "@/lib/tax-compliance/reports";
import { getTaxProfile, prepareFiling } from "@/lib/tax-compliance/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const Query = z.object({ regime: z.string().optional(), from: z.string().regex(DATE), to: z.string().regex(DATE), format: z.enum(["json", "csv"]).default("json") });

/** GET /api/tax/reports?regime=&from=YYYY-MM-DD&to=&format=json|csv */
export async function GET(req: NextRequest) {
  try {
    const scope = await requireScope({ area: "billing" });
    const gate = await planGate(scope, { feature: "tax_compliance" });
    if (gate) return gate;
    const rl = await rateLimitAsync(`tax-report:${scope.dataId}`, 30, 60_000);
    if (!rl.allowed) return NextResponse.json({ error: "rate_limited" }, { status: 429 });
    const sp = req.nextUrl.searchParams;
    const q = Query.safeParse({ regime: sp.get("regime") ?? undefined, from: sp.get("from"), to: sp.get("to"), format: sp.get("format") ?? undefined });
    if (!q.success) return NextResponse.json({ error: "invalid_query", detail: q.error.flatten() }, { status: 400 });
    if (q.data.from > q.data.to) return NextResponse.json({ error: "from_after_to" }, { status: 400 });
    const profile = await getTaxProfile(scope.dataId);
    const regime = q.data.regime ?? profile?.regime ?? "generic";
    if (!isRegime(regime)) return NextResponse.json({ error: "unknown_regime", regimes: REGIMES }, { status: 400 });
    const report = await loadReport(scope.dataId, regime, q.data.from, q.data.to, profile);
    if (q.data.format === "csv") {
      return new NextResponse(reportToCsv(report), { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="tax-${regime}-${q.data.from}_${q.data.to}.csv"` } });
    }
    return NextResponse.json({ report });
  } catch (err) {
    return errorResponse(err, "tax.reports.GET");
  }
}

const Prepare = z.object({ regime: z.enum(REGIMES), from: z.string().regex(DATE), to: z.string().regex(DATE), notes: z.string().max(2000).nullable().optional() }).strict();

/** POST /api/tax/reports - "Prepare filing": recompute the report and save a tax_filings row (status prepared). */
export async function POST(req: NextRequest) {
  try {
    const scope = await requireScope({ area: "billing", edit: true });
    const gate = await planGate(scope, { feature: "tax_compliance" });
    if (gate) return gate;
    const body = await parseBody(req, Prepare, 4_000);
    if (!body.ok) return body.res;
    if (body.data.from > body.data.to) return NextResponse.json({ error: "from_after_to" }, { status: 400 });
    const report = await loadReport(scope.dataId, body.data.regime, body.data.from, body.data.to);
    const filing = await prepareFiling(scope.dataId, {
      regime: body.data.regime, period_start: `${body.data.from}T00:00:00.000Z`, period_end: `${body.data.to}T23:59:59.000Z`,
      totals: { ...report.totals, currency: report.currency, warnings: report.warnings.length }, report_hash: report.report_hash, notes: body.data.notes ?? null,
    });
    await recordAudit(scope, { action: "tax.filing.prepare", entity: "tax_filing", entityId: filing.id, after: { regime: filing.regime, report_hash: filing.report_hash } });
    return NextResponse.json({ filing, report_hash: report.report_hash }, { status: 201 });
  } catch (err) {
    return errorResponse(err, "tax.reports.POST");
  }
}
