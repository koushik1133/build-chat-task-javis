import { NextResponse, type NextRequest } from "next/server";
import { readCappedText } from "@/lib/request-limits";
import { processWebhook } from "@/lib/payments/webhook";

export const runtime = "nodejs";

const MAX_BODY = 256 * 1024;

/** Provider payment webhooks. Raw body is verified before any parsing; unverifiable → 401. */
export async function POST(req: NextRequest, ctx: { params: Promise<{ provider: string }> }) {
  const { provider } = await ctx.params;
  const raw = await readCappedText(req, MAX_BODY);
  if (raw === null) return NextResponse.json({ error: "payload_too_large" }, { status: 413 });
  try {
    const out = await processWebhook(provider, raw, req.headers);
    return NextResponse.json(out.body, { status: out.status });
  } catch (err) {
    console.error("[payments.webhook]", err);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
