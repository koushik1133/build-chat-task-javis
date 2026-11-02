import { NextResponse, type NextRequest } from "next/server";
import { requireScope } from "@/lib/auth/scope";
import { parseBody } from "@/lib/money/http";
import { dateParam, financeErrorResponse } from "@/lib/finance/http";
import { createExpense, ExpenseInputSchema, listExpenses } from "@/lib/finance/expenses";

export const runtime = "nodejs";

/** GET /api/expenses?from=&to=&ref=kind:id&unbilled=1 */
export async function GET(req: NextRequest) {
  try {
    const scope = await requireScope({ area: "billing" });
    const sp = req.nextUrl.searchParams;
    const expenses = await listExpenses(scope.dataId, {
      from: dateParam(req, "from"),
      to: dateParam(req, "to"),
      ref: sp.get("ref"),
      unbilledOnly: sp.get("unbilled") === "1",
    });
    return NextResponse.json({ expenses });
  } catch (err) {
    return financeErrorResponse(err, "expenses.GET");
  }
}

export async function POST(req: NextRequest) {
  try {
    const scope = await requireScope({ area: "billing", edit: true });
    const body = await parseBody(req, ExpenseInputSchema);
    if (!body.ok) return body.res;
    const expense = await createExpense(scope.dataId, body.data, scope.userId);
    return NextResponse.json({ expense }, { status: 201 });
  } catch (err) {
    return financeErrorResponse(err, "expenses.POST");
  }
}
