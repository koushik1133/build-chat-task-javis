import { NextResponse, type NextRequest } from "next/server";
import { requireScope } from "@/lib/auth/scope";
import { paramId, parseBody } from "@/lib/money/http";
import { financeErrorResponse } from "@/lib/finance/http";
import { ChangeOrderPatchSchema, deleteChangeOrder, getChangeOrder, updateChangeOrder } from "@/lib/finance/change-orders";

export const runtime = "nodejs";
type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, ctx: Ctx) {
  try {
    const scope = await requireScope({ area: "billing" });
    const change_order = await getChangeOrder(scope.dataId, await paramId(ctx));
    if (!change_order) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ change_order });
  } catch (err) {
    return financeErrorResponse(err, "change-orders.id.GET");
  }
}

/** PATCH fields and/or {status}. status=accepted bills the items to the linked draft invoice or a new one. */
export async function PATCH(req: NextRequest, ctx: Ctx) {
  try {
    const scope = await requireScope({ area: "billing", edit: true });
    const body = await parseBody(req, ChangeOrderPatchSchema);
    if (!body.ok) return body.res;
    const result = await updateChangeOrder(scope.dataId, await paramId(ctx), body.data);
    return NextResponse.json(result);
  } catch (err) {
    return financeErrorResponse(err, "change-orders.id.PATCH");
  }
}

export async function DELETE(_req: NextRequest, ctx: Ctx) {
  try {
    const scope = await requireScope({ area: "billing", edit: true });
    const ok = await deleteChangeOrder(scope.dataId, await paramId(ctx));
    if (!ok) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return new NextResponse(null, { status: 204 });
  } catch (err) {
    return financeErrorResponse(err, "change-orders.id.DELETE");
  }
}
