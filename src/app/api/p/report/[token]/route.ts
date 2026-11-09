import { NextResponse, type NextRequest } from "next/server";
import { resolveShareToken } from "@/lib/share-tokens";
import { publicRateLimit } from "@/lib/money/http";
import { getSavedReportById } from "@/lib/reports/store";
import { runReport } from "@/lib/reports/query";
import { buildReportExport } from "@/lib/reports/render";

export const runtime = "nodejs";

/** GET /api/p/report/[token]?format=csv|pdf — public download for a scheduled report link (7-day token). */
export async function GET(req: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  const limited = await publicRateLimit(req, "report", 30);
  if (limited) return limited;
  try {
    const share = await resolveShareToken("report", (await ctx.params).token);
    if (!share) return NextResponse.json({ error: "not_found" }, { status: 404 });
    const report = await getSavedReportById(share.user_id, share.entity_id);
    if (!report) return NextResponse.json({ error: "not_found" }, { status: 404 });
    const format = req.nextUrl.searchParams.get("format") === "pdf" ? "pdf" : "csv";
    const result = await runReport(share.user_id, report.spec);
    return buildReportExport(share.user_id, report, result, format);
  } catch (err) {
    console.error("[p.report.GET]", err);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
