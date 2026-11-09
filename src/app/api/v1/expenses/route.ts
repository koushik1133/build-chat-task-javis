import { createExpense, listExpenses } from "@/lib/finance/expenses";
import { ROUTES } from "@/lib/public-api/registry";
import { op, libCall, singlePage } from "@/lib/public-api/handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = op(ROUTES.listExpenses, async ({ principal, query, list }) => {
  const rows = await listExpenses(principal.dataId, { from: query.from ?? null, to: query.to ?? null, ref: query.ref ?? null, unbilledOnly: query.unbilled === "true", limit: list.limit });
  return singlePage(query.category ? rows.filter((r) => r.category === query.category) : rows);
});

export const POST = op(ROUTES.createExpense, async ({ principal, body }) => ({
  data: await libCall(() => createExpense(principal.dataId, body, `api_key:${principal.keyId}`)),
  status: 201,
}));
