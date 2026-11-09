import { NextResponse, type NextRequest } from "next/server";
import { requireScope } from "@/lib/auth/scope";
import { createRecord, listRecords, stageCounts } from "@/lib/records/store";
import { RecordBodySchema, parseBody, recordsErrorResponse, resolveType, type TypeCtx } from "@/lib/records/http";
import { normaliseCursor, page, parseListParams } from "@/lib/public-api/pagination";

export const runtime = "nodejs";

export async function GET(req: NextRequest, ctx: TypeCtx) {
  try {
    const scope = await requireScope({ area: "crm" });
    const t = await resolveType(scope.dataId, (await ctx.params).type);
    if (!t.ok) return t.res;
    const sp = req.nextUrl.searchParams;
    // Table view pages with ?order=created&cursor=&limit= (keyset, newest first);
    // the board keeps the legacy "every record, by updated_at" payload.
    const paged = sp.get("order") === "created" || sp.has("cursor");
    if (paged) {
      const list = parseListParams(req.nextUrl, { limit: 50 });
      if (list.badCursor) return NextResponse.json({ error: "invalid cursor" }, { status: 400 });
      const [rows, counts] = await Promise.all([
        listRecords(scope.dataId, t.type, { stage: sp.get("stage"), q: list.q, limit: list.limit + 1, order: "created", cursor: list.cursor }),
        stageCounts(scope.dataId, t.type),
      ]);
      const pg = page(rows, list.limit, (r) => normaliseCursor({ created_at: r.created_at, id: r.id }));
      return NextResponse.json({ type: t.type, records: pg.data, counts, next_cursor: pg.next_cursor });
    }
    const limitRaw = Number(sp.get("limit") ?? "200");
    const [records, counts] = await Promise.all([
      listRecords(scope.dataId, t.type, {
        stage: sp.get("stage"),
        q: sp.get("q"),
        limit: Number.isFinite(limitRaw) ? limitRaw : 200,
      }),
      stageCounts(scope.dataId, t.type),
    ]);
    return NextResponse.json({ type: t.type, records, counts, next_cursor: null });
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
