import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireScope } from "@/lib/auth/scope";
import { parseBody } from "@/lib/money/http";
import { financeErrorResponse } from "@/lib/finance/http";
import { rateLimitAsync } from "@/lib/request-limits";
import { createBillFromPO, createSupplierBill, listSupplierBills, SupplierBillInputSchema } from "@/lib/procurement/bills";
import { normaliseCursor, page, parseListParams } from "@/lib/public-api/pagination";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/supplier-bills?status=&supplier=&overdue=1&cursor=&limit= */
export async function GET(req: NextRequest) {
  try {
    const scope = await requireScope({ area: "billing" });
    const sp = req.nextUrl.searchParams;
    const list = parseListParams(req.nextUrl, { limit: 50 });
    if (list.badCursor) return NextResponse.json({ error: "invalid cursor" }, { status: 400 });
    const rows = await listSupplierBills(scope.dataId, { status: sp.get("status"), supplierId: sp.get("supplier"), overdueOnly: sp.get("overdue") === "1", cursor: list.cursor, limit: list.limit + 1 });
    const pg = page(rows, list.limit, (r) => normaliseCursor({ created_at: r.created_at, id: r.id }));
    return NextResponse.json({ bills: pg.data, next_cursor: pg.next_cursor });
  } catch (err) {
    return financeErrorResponse(err, "supplier-bills.GET");
  }
}

/** Either a full bill body, or `{ from_purchase_order_id, supplier_ref?, due_at? }` to bill a PO. */
const FromPoSchema = z
  .object({
    from_purchase_order_id: z.string().min(1).max(100),
    supplier_ref: z.string().trim().max(100).nullable().optional(),
    due_at: z.string().datetime({ offset: true }).nullable().optional(),
  })
  .strict();

export async function POST(req: NextRequest) {
  try {
    const scope = await requireScope({ area: "billing", edit: true });
    const rl = await rateLimitAsync(`bills:create:${scope.dataId}`, 120, 60_000);
    if (!rl.allowed) return NextResponse.json({ error: "rate_limited" }, { status: 429 });
    const body = await parseBody(req, z.union([FromPoSchema, SupplierBillInputSchema]), 256_000);
    if (!body.ok) return body.res;
    const bill =
      "from_purchase_order_id" in body.data
        ? await createBillFromPO(scope.dataId, body.data.from_purchase_order_id, { supplier_ref: body.data.supplier_ref ?? null, due_at: body.data.due_at ?? null })
        : await createSupplierBill(scope.dataId, body.data);
    return NextResponse.json({ bill }, { status: 201 });
  } catch (err) {
    return financeErrorResponse(err, "supplier-bills.POST");
  }
}
