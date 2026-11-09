import { deleteExpense, getExpense, updateExpense } from "@/lib/finance/expenses";
import { ROUTES } from "@/lib/public-api/registry";
import { ApiError } from "@/lib/public-api/envelope";
import { op, libCall, mustFind } from "@/lib/public-api/handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = op(ROUTES.getExpense, async ({ principal, params }) => ({ data: mustFind(await getExpense(principal.dataId, params.id), "Expense") }));

export const PATCH = op(ROUTES.updateExpense, async ({ principal, params, body }) => {
  mustFind(await getExpense(principal.dataId, params.id), "Expense");
  return { data: await libCall(() => updateExpense(principal.dataId, params.id, body)) };
});

export const DELETE = op(ROUTES.deleteExpense, async ({ principal, params }) => {
  if (!(await deleteExpense(principal.dataId, params.id))) throw ApiError.notFound("Expense");
  return { data: { id: params.id, deleted: true as const } };
});
