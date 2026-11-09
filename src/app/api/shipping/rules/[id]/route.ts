import { NextResponse, type NextRequest } from "next/server";
import { requireScope } from "@/lib/auth/scope";
import { parseBody, paramId } from "@/lib/money/http";
import { shippingError } from "@/lib/shipping/http";
 import { deleteRule, updateRule } from "@/lib/shipping/quote";
import { RuleInputSchema } from "@/lib/shipping/rules";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function PUT(req: NextRequest, ctx: Ctx) {
  try {
    const scope = await requireScope({ area: "billing", edit: true });
    const body = await parseBody(req, RuleInputSchema);
    if (!body.ok) return body.res;
    return NextResponse.json({ rule: await updateRule(scope.dataId, await paramId(ctx), body.data) });
  } catch (err) {
    return shippingError(err, "shipping.rules.PUT");
  }
}

export async function DELETE(_req: NextRequest, ctx: Ctx) {
  try {
    const scope = await requireScope({ area: "billing", edit: true });
    await deleteRule(scope.dataId, await paramId(ctx));
    return NextResponse.json({ ok: true });
  } catch (err) {
    return shippingError(err, "shipping.rules.DELETE");
  }
}
