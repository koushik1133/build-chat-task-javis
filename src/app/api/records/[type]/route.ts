import { NextResponse, type NextRequest } from "next/server";
import { requireScope } from "@/lib/auth/scope";
import { createRecord, listRecords, stageCounts } from "@/lib/records/store";
import { RecordBodySchema, parseBody, recordsErrorResponse, resolveType, type TypeCtx } from "@/lib/records/http";

export const runtime = "nodejs";

export async function GET(req: NextRequest, ctx: TypeCtx) {
  try {
    const scope = await requireScope({ area: "crm" });
    const t = await resolveType(scope.dataId, (await ctx.params).type);
    if (!t.ok) return t.res;
    const sp = req.nextUrl.searchParams;
    const limitRaw = Number(sp.get("limit") ?? "200");
    const records = await listRecords(scope.dataId, t.type, {
      stage: sp.get("stage"),
      q: sp.get("q"),
      limit: Number.isFinite(limitRaw) ? limitRaw : 200,
    });
    const counts = await stageCounts(scope.dataId, t.type);
    return NextResponse.json({ type: t.type, records, counts });
  } catch (err) {
    return recordsErrorResponse(err, "records.type.GET");
  }
}

export async function POST(req: NextRequest, ctx: TypeCtx) {
  try {
    const scope = await requireScope({ area: "crm", edit: true });
    const t = await resolveType(scope.dataId, (await ctx.params).type);
    if (!t.ok) return t.res;
    const body = await parseBody(req, RecordBodySchema);
    if (!body.ok) return body.res;
    const record = await createRecord(scope.dataId, t.type, { ...body.data, actorId: scope.userId });
    return NextResponse.json({ record }, { status: 201 });
  } catch (err) {
    return recordsErrorResponse(err, "records.type.POST");
  }
}
