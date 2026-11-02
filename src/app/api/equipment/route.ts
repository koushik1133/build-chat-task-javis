import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireScope } from "@/lib/auth/scope";
import { parseBody } from "@/lib/money/http";
import { financeErrorResponse, idParam } from "@/lib/finance/http";
import { checkinEquipment, checkoutEquipment, listCheckouts } from "@/lib/inventory/stock";

export const runtime = "nodejs";

const CheckoutBody = z
  .object({
    product_id: z.string().min(1).max(100),
    qty: z.number().int().min(1).max(100_000).default(1),
    checked_out_to: z.string().trim().max(200).nullable().optional(),
    ref_kind: z.string().trim().max(40).nullable().optional(),
    ref_id: z.string().trim().max(100).nullable().optional(),
    due_back_at: z.string().datetime({ offset: true }).nullable().optional(),
  })
  .strict();

/** GET /api/equipment?open=1 */
export async function GET(req: NextRequest) {
  try {
    const scope = await requireScope({ area: "billing" });
    const checkouts = await listCheckouts(scope.dataId, { open: req.nextUrl.searchParams.get("open") === "1" });
    return NextResponse.json({ checkouts });
  } catch (err) {
    return financeErrorResponse(err, "equipment.GET");
  }
}

/** POST /api/equipment — check equipment out (reserves stock). */
export async function POST(req: NextRequest) {
  try {
    const scope = await requireScope({ area: "billing", edit: true });
    const body = await parseBody(req, CheckoutBody);
    if (!body.ok) return body.res;
    const checkout = await checkoutEquipment(scope.dataId, body.data, scope.userId);
    return NextResponse.json({ checkout }, { status: 201 });
  } catch (err) {
    return financeErrorResponse(err, "equipment.POST");
  }
}

/** PATCH /api/equipment?id= — check back in. */
export async function PATCH(req: NextRequest) {
  try {
    const scope = await requireScope({ area: "billing", edit: true });
    const id = idParam(req);
    if (!id) return NextResponse.json({ error: "missing_id" }, { status: 400 });
    const checkout = await checkinEquipment(scope.dataId, id, scope.userId);
    return NextResponse.json({ checkout });
  } catch (err) {
    return financeErrorResponse(err, "equipment.PATCH");
  }
}
