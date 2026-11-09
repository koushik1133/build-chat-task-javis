import { NextResponse, type NextRequest } from "next/server";
import { requireScope, scopeErrorResponse } from "@/lib/auth/scope";
import { errorResponse, paramId } from "@/lib/money/http";
import { voidDocument } from "@/lib/documents/documents";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/documents/[id]/void — withdraw a sent document; its signing links stop working. */
export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  let scope;
  try {
    scope = await requireScope({ area: "crm", edit: true });
  } catch (err) {
    return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const document = await voidDocument(scope.dataId, await paramId(ctx), scope.userId);
    return NextResponse.json({ document });
  } catch (err) {
    return errorResponse(err, "documents.id.void");
  }
}
