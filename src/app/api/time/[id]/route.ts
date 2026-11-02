import { NextResponse, type NextRequest } from "next/server";
import { requireScope } from "@/lib/auth/scope";
import { paramId, parseBody } from "@/lib/money/http";
import { financeErrorResponse } from "@/lib/finance/http";
import { deleteTimeEntry, getTimeEntry, TimeEntryPatchSchema, updateTimeEntry } from "@/lib/finance/time";

export const runtime = "nodejs";
type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, ctx: Ctx) {
  try {
    const scope = await requireScope({ area: "billing" });
    const entry = await getTimeEntry(scope.dataId, await paramId(ctx));
    if (!entry) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ entry });
  } catch (err) {
    return financeErrorResponse(err, "time.id.GET");
  }
}

export async function PATCH(req: NextRequest, ctx: Ctx) {
  try {
    const scope = await requireScope({ area: "billing", edit: true });
    const body = await parseBody(req, TimeEntryPatchSchema);
    if (!body.ok) return body.res;
    const entry = await updateTimeEntry(scope.dataId, await paramId(ctx), body.data);
    return NextResponse.json({ entry });
  } catch (err) {
    return financeErrorResponse(err, "time.id.PATCH");
  }
}

export async function DELETE(_req: NextRequest, ctx: Ctx) {
  try {
    const scope = await requireScope({ area: "billing", edit: true });
    const ok = await deleteTimeEntry(scope.dataId, await paramId(ctx));
    if (!ok) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return new NextResponse(null, { status: 204 });
  } catch (err) {
    return financeErrorResponse(err, "time.id.DELETE");
  }
}
