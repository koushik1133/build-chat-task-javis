import { NextResponse, type NextRequest } from "next/server";
import { requireScope } from "@/lib/auth/scope";
import { getRecord, listActivity, listLinks, softDeleteRecord, updateRecord } from "@/lib/records/store";
import { RecordPatchSchema, parseBody, recordsErrorResponse, resolveType, type TypeIdCtx } from "@/lib/records/http";

export const runtime = "nodejs";

export async function GET(_req: NextRequest, ctx: TypeIdCtx) {
  try {
    const scope = await requireScope({ area: "crm" });
    const { type: typeParam, id } = await ctx.params;
    const t = await resolveType(scope.dataId, typeParam);
    if (!t.ok) return t.res;
    const record = await getRecord(scope.dataId, id);
    if (!record || record.type_id !== t.type.id) return NextResponse.json({ error: "not_found" }, { status: 404 });
    const [activity, links] = await Promise.all([listActivity(scope.dataId, id), listLinks(scope.dataId, id)]);
    return NextResponse.json({ record, activity, links });
  } catch (err) {
    return recordsErrorResponse(err, "records.type.id.GET");
  }
}

export async function PATCH(req: NextRequest, ctx: TypeIdCtx) {
  try {
    const scope = await requireScope({ area: "crm", edit: true });
    const { type: typeParam, id } = await ctx.params;
    const t = await resolveType(scope.dataId, typeParam);
    if (!t.ok) return t.res;
    const body = await parseBody(req, RecordPatchSchema);
    if (!body.ok) return body.res;
    const { stage: _ignoredStage, ...rest } = body.data;
    void _ignoredStage; // stage changes go through /move so they emit events
    const record = await updateRecord(scope.dataId, t.type, id, { ...rest, actorId: scope.userId });
    return NextResponse.json({ record });
  } catch (err) {
    return recordsErrorResponse(err, "records.type.id.PATCH");
  }
}

export async function DELETE(_req: NextRequest, ctx: TypeIdCtx) {
  try {
    const scope = await requireScope({ area: "crm", edit: true });
    const { type: typeParam, id } = await ctx.params;
    const t = await resolveType(scope.dataId, typeParam);
    if (!t.ok) return t.res;
    const ok = await softDeleteRecord(scope.dataId, t.type, id);
    if (!ok) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return recordsErrorResponse(err, "records.type.id.DELETE");
  }
}
