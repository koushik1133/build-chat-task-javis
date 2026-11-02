import { NextResponse, type NextRequest } from "next/server";
import { requireScope } from "@/lib/auth/scope";
import { RecordTypePatchSchema } from "@/lib/records/schema";
import { deleteType, getType, stageCounts, updateType } from "@/lib/records/store";
import { parseBody, recordsErrorResponse, type IdCtx } from "@/lib/records/http";

export const runtime = "nodejs";

export async function GET(_req: NextRequest, ctx: IdCtx) {
  try {
    const scope = await requireScope({ area: "crm" });
    const type = await getType(scope.dataId, (await ctx.params).id);
    if (!type) return NextResponse.json({ error: "not_found" }, { status: 404 });
    const counts = await stageCounts(scope.dataId, type);
    return NextResponse.json({ type, counts });
  } catch (err) {
    return recordsErrorResponse(err, "records.types.id.GET");
  }
}

export async function PATCH(req: NextRequest, ctx: IdCtx) {
  try {
    const scope = await requireScope({ area: "crm", edit: true });
    const body = await parseBody(req, RecordTypePatchSchema);
    if (!body.ok) return body.res;
    const type = await updateType(scope.dataId, (await ctx.params).id, body.data);
    return NextResponse.json({ type });
  } catch (err) {
    return recordsErrorResponse(err, "records.types.id.PATCH");
  }
}

export async function DELETE(_req: NextRequest, ctx: IdCtx) {
  try {
    const scope = await requireScope({ area: "crm", edit: true });
    const ok = await deleteType(scope.dataId, (await ctx.params).id);
    if (!ok) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return recordsErrorResponse(err, "records.types.id.DELETE");
  }
}
