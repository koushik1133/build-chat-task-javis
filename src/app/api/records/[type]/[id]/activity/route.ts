import { NextResponse, type NextRequest } from "next/server";
import { requireScope } from "@/lib/auth/scope";
import { addActivity, getRecord, listActivity } from "@/lib/records/store";
import { CommentBodySchema, parseBody, recordsErrorResponse, resolveType, type TypeIdCtx } from "@/lib/records/http";

export const runtime = "nodejs";

export async function GET(_req: NextRequest, ctx: TypeIdCtx) {
  try {
    const scope = await requireScope({ area: "crm" });
    const { type: typeParam, id } = await ctx.params;
    const t = await resolveType(scope.dataId, typeParam);
    if (!t.ok) return t.res;
    const record = await getRecord(scope.dataId, id);
    if (!record || record.type_id !== t.type.id) return NextResponse.json({ error: "not_found" }, { status: 404 });
    const activity = await listActivity(scope.dataId, id);
    return NextResponse.json({ activity });
  } catch (err) {
    return recordsErrorResponse(err, "records.type.id.activity.GET");
  }
}

/** Add a comment to the record's timeline. */
export async function POST(req: NextRequest, ctx: TypeIdCtx) {
  try {
    const scope = await requireScope({ area: "crm", edit: true });
    const { type: typeParam, id } = await ctx.params;
    const t = await resolveType(scope.dataId, typeParam);
    if (!t.ok) return t.res;
    const record = await getRecord(scope.dataId, id);
    if (!record || record.type_id !== t.type.id) return NextResponse.json({ error: "not_found" }, { status: 404 });
    const body = await parseBody(req, CommentBodySchema);
    if (!body.ok) return body.res;
    const activity = await addActivity(scope.dataId, id, { kind: "comment", actorId: scope.userId, body: body.data.body });
    return NextResponse.json({ activity }, { status: 201 });
  } catch (err) {
    return recordsErrorResponse(err, "records.type.id.activity.POST");
  }
}
