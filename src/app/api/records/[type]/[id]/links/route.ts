import { NextResponse, type NextRequest } from "next/server";
import { requireScope } from "@/lib/auth/scope";
import { getRecord, link, listLinks } from "@/lib/records/store";
import { LinkBodySchema, parseBody, recordsErrorResponse, resolveType, type TypeIdCtx } from "@/lib/records/http";

export const runtime = "nodejs";

export async function GET(_req: NextRequest, ctx: TypeIdCtx) {
  try {
    const scope = await requireScope({ area: "crm" });
    const { type: typeParam, id } = await ctx.params;
    const t = await resolveType(scope.dataId, typeParam);
    if (!t.ok) return t.res;
    const record = await getRecord(scope.dataId, id);
    if (!record || record.type_id !== t.type.id) return NextResponse.json({ error: "not_found" }, { status: 404 });
    const links = await listLinks(scope.dataId, id);
    return NextResponse.json({ links });
  } catch (err) {
    return recordsErrorResponse(err, "records.type.id.links.GET");
  }
}

/** Link the record to a contact, task, quote, invoice, booking or another record. */
export async function POST(req: NextRequest, ctx: TypeIdCtx) {
  try {
    const scope = await requireScope({ area: "crm", edit: true });
    const { type: typeParam, id } = await ctx.params;
    const t = await resolveType(scope.dataId, typeParam);
    if (!t.ok) return t.res;
    const record = await getRecord(scope.dataId, id);
    if (!record || record.type_id !== t.type.id) return NextResponse.json({ error: "not_found" }, { status: 404 });
    const body = await parseBody(req, LinkBodySchema);
    if (!body.ok) return body.res;
    if (body.data.target_kind === "record") {
      const target = await getRecord(scope.dataId, body.data.target_id);
      if (!target) return NextResponse.json({ error: "not_found", detail: "Target record not found" }, { status: 404 });
    }
    const created = await link(scope.dataId, id, body.data.target_kind, body.data.target_id, scope.userId);
    return NextResponse.json({ link: created }, { status: 201 });
  } catch (err) {
    return recordsErrorResponse(err, "records.type.id.links.POST");
  }
}
