import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireScope } from "@/lib/auth/scope";
import { paramId, parseBody } from "@/lib/money/http";
import { financeErrorResponse } from "@/lib/finance/http";
import { attachBillables } from "@/lib/finance/billables";

export const runtime = "nodejs";
type Ctx = { params: Promise<{ id: string }> };

const Body = z
  .object({
    expenseIds: z.array(z.string().min(1).max(100)).max(200).default([]),
    timeEntryIds: z.array(z.string().min(1).max(100)).max(200).default([]),
  })
  .strict();

/** POST /api/invoices/[id]/billables {expenseIds[], timeEntryIds[]} → appends line items to a draft invoice. */
export async function POST(req: NextRequest, ctx: Ctx) {
  try {
    const scope = await requireScope({ area: "billing", edit: true });
    const body = await parseBody(req, Body);
    if (!body.ok) return body.res;
    const result = await attachBillables(scope.dataId, await paramId(ctx), body.data);
    return NextResponse.json(result);
  } catch (err) {
    return financeErrorResponse(err, "invoices.id.billables.POST");
  }
}
