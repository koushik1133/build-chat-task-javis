import { NextResponse, type NextRequest } from "next/server";
import { requireScope } from "@/lib/auth/scope";
import { parseBody } from "@/lib/money/http";
import { shippingError } from "@/lib/shipping/http";
 import { createRule, listRules } from "@/lib/shipping/quote";
import { RuleInputSchema } from "@/lib/shipping/rules";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const scope = await requireScope({ area: "billing", edit: false });
    return NextResponse.json({ rules: await listRules(scope.dataId) });
  } catch (err) {
    return shippingError(err, "shipping.rules.GET");
  }
}

export async function POST(req: NextRequest) {
  try {
    const scope = await requireScope({ area: "billing", edit: true });
    const body = await parseBody(req, RuleInputSchema);
    if (!body.ok) return body.res;
    return NextResponse.json({ rule: await createRule(scope.dataId, body.data) }, { status: 201 });
  } catch (err) {
    return shippingError(err, "shipping.rules.POST");
  }
}
