import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireScope } from "@/lib/auth/scope";
import { declineQuote } from "@/lib/money/quotes";
import { errorResponse, paramId, parseBody } from "@/lib/money/http";

export const runtime = "nodejs";

const Body = z.object({ reason: z.string().trim().max(2000).optional() }).strict();

/** Owner-side decline (client said no by phone, deal lost, …). Releases reserved stock. */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const scope = await requireScope({ area: "billing", edit: true });
    const body = await parseBody(req, Body, 8_192);
    if (!body.ok) return body.res;
    const out = await declineQuote(scope.dataId, await paramId(ctx), body.data.reason ?? null, { by: "owner" });
    return NextResponse.json({ quote: out.quote, released: out.released });
  } catch (err) {
    return errorResponse(err, "quotes.id.decline.POST");
  }
}
