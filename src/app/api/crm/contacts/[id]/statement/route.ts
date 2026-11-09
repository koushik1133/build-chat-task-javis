import { NextResponse, type NextRequest } from "next/server";
import { requireScope } from "@/lib/auth/scope";
import { buildStatement } from "@/lib/money/statements";
import { errorResponse, paramId } from "@/lib/money/http";
import { buildStatementPdf, pdfResponse } from "@/lib/pdf/documents";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function parseRange(params: URLSearchParams): { from: Date | null; to: Date | null } | { error: string } {
  const parse = (k: string): Date | null | { error: string } => {
    const v = params.get(k);
    if (!v) return null;
    const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T${k === "to" ? "23:59:59.999" : "00:00:00"}Z` : v);
    return Number.isNaN(d.getTime()) ? { error: `invalid ${k}` } : d;
  };
  const from = parse("from");
  const to = parse("to");
  if (from && "error" in from) return from;
  if (to && "error" in to) return to;
  return { from: from as Date | null, to: to as Date | null };
}

/** GET /api/crm/contacts/[id]/statement?from=&to=&format=pdf — customer statement (billing area). */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const scope = await requireScope({ area: "billing" });
    const range = parseRange(req.nextUrl.searchParams);
    if ("error" in range) return NextResponse.json({ error: "bad_request", detail: range.error }, { status: 400 });
    const statement = await buildStatement(scope.dataId, await paramId(ctx), range);
    if (!statement) return NextResponse.json({ error: "not_found" }, { status: 404 });
    if (req.nextUrl.searchParams.get("format") === "pdf") {
      const built = await buildStatementPdf(scope.dataId, statement);
      return pdfResponse(built, req.nextUrl.searchParams.get("download") ? "attachment" : "inline");
    }
    return NextResponse.json({ statement });
  } catch (err) {
    return errorResponse(err, "crm.contacts.id.statement.GET");
  }
}
