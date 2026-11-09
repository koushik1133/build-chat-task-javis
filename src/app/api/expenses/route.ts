import { NextResponse, type NextRequest } from "next/server";
import { requireScope } from "@/lib/auth/scope";
import { parseBody } from "@/lib/money/http";
import { dateParam, financeErrorResponse } from "@/lib/finance/http";
import { createExpense, ExpenseInputSchema, listExpenses } from "@/lib/finance/expenses";
import { normaliseCursor, page, parseListParams } from "@/lib/public-api/pagination";

export const runtime = "nodejs";

/** GET /api/expenses?from=&to=&ref=kind:id&unbilled=1[&order=created&cursor=&limit=] (keyset paging when `order=created`/cursor). */
export async function GET(req: NextRequest) {
  try {
    const scope = await requireScope({ area: "billing" });
    const sp = req.nextUrl.searchParams;
    const paged = sp.get("order") === "created" || sp.has("cursor");
    const list = parseListParams(req.nextUrl, { limit: 50 });
    if (paged && list.badCursor) return NextResponse.json({ error: "invalid cursor" }, { status: 400 });
    const rows = await listExpenses(scope.dataId, {
      from: dateParam(req, "from"),
      to: dateParam(req, "to"),
      ref: sp.get("ref"),
      unbilledOnly: sp.get("unbilled") === "1",
      ...(paged ? { order: "created" as const, cursor: list.cursor, limit: list.limit + 1 } : {}),
    });
    if (!paged) return NextResponse.json({ expenses: rows, next_cursor: null });
    const pg = page(rows, list.limit, (r) => normaliseCursor({ created_at: r.created_at, id: r.id }));
    return NextResponse.json({ expenses: pg.data, next_cursor: pg.next_cursor });
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
