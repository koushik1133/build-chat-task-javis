import { NextResponse, type NextRequest } from "next/server";
import { requireScope } from "@/lib/auth/scope";
import { sendQuote } from "@/lib/money/quotes";
import { SendBodySchema, errorResponse, paramId, parseBody } from "@/lib/money/http";

export const runtime = "nodejs";

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const scope = await requireScope({ area: "billing", edit: true });
    const body = await parseBody(req, SendBodySchema);
    if (!body.ok) return body.res;
    const out = await sendQuote(scope.dataId, await paramId(ctx), body.data);
    return NextResponse.json(out);
  } catch (err) {
    return errorResponse(err, "quotes.send");
  }
}
