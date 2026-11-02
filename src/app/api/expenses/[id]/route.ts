import { NextResponse, type NextRequest } from "next/server";
import { requireScope } from "@/lib/auth/scope";
import { paramId, parseBody } from "@/lib/money/http";
import { financeErrorResponse } from "@/lib/finance/http";
import { deleteExpense, ExpensePatchSchema, getExpense, updateExpense } from "@/lib/finance/expenses";

export const runtime = "nodejs";
type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, ctx: Ctx) {
  try {
    const scope = await requireScope({ area: "billing" });
    const expense = await getExpense(scope.dataId, await paramId(ctx));
    if (!expense) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ expense });
  } catch (err) {
    return financeErrorResponse(err, "expenses.id.GET");
  }
}

export async function PATCH(req: NextRequest, ctx: Ctx) {
  try {
    const scope = await requireScope({ area: "billing", edit: true });
    const body = await parseBody(req, ExpensePatchSchema);
    if (!body.ok) return body.res;
    const expense = await updateExpense(scope.dataId, await paramId(ctx), body.data);
    return NextResponse.json({ expense });
  } catch (err) {
    return financeErrorResponse(err, "expenses.id.PATCH");
  }
}

export async function DELETE(_req: NextRequest, ctx: Ctx) {
  try {
    const scope = await requireScope({ area: "billing", edit: true });
    const ok = await deleteExpense(scope.dataId, await paramId(ctx));
    if (!ok) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return new NextResponse(null, { status: 204 });
  } catch (err) {
    return financeErrorResponse(err, "expenses.id.DELETE");
  }
}
