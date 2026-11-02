import { NextResponse, type NextRequest } from "next/server";
import { requireScope } from "@/lib/auth/scope";
import { moveRecord } from "@/lib/records/store";
import { MoveBodySchema, parseBody, recordsErrorResponse, resolveType, type TypeIdCtx } from "@/lib/records/http";

export const runtime = "nodejs";

/** Move a record to another stage. Emits `record.moved`. */
export async function POST(req: NextRequest, ctx: TypeIdCtx) {
  try {
    const scope = await requireScope({ area: "crm", edit: true });
    const { type: typeParam, id } = await ctx.params;
    const t = await resolveType(scope.dataId, typeParam);
    if (!t.ok) return t.res;
    const body = await parseBody(req, MoveBodySchema);
    if (!body.ok) return body.res;
    const record = await moveRecord(scope.dataId, t.type, id, body.data.stage, scope.userId);
    return NextResponse.json({ record });
  } catch (err) {
    return recordsErrorResponse(err, "records.type.id.move.POST");
  }
}
