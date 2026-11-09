import { NextResponse, type NextRequest } from "next/server";
import { readCappedText, rateLimitAsync, clientIp } from "@/lib/request-limits";
import { handleProviderWebhook } from "@/lib/shipping/tracking";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/shipping/webhook/[provider] — carrier tracking webhooks (easypost | shippo | simulated).
 * Public: authenticity comes from the per-provider signature, not a session. Replays are harmless (idempotent ingestion).
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ provider: string }> }) {
  const rl = await rateLimitAsync(`ship-wh:${clientIp(req)}`, 300, 60_000);
  if (!rl.allowed) return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  const { provider } = await ctx.params;
  const raw = await readCappedText(req, 512_000);
  if (raw === null) return NextResponse.json({ error: "payload_too_large" }, { status: 413 });
  try {
    const out = await handleProviderWebhook(provider, raw, req.headers, new URL(req.url));
    if (!out.ok) return NextResponse.json({ error: "invalid_signature" }, { status: 401 });
    return NextResponse.json({ ok: true, events: out.events, matched: out.matched });
  } catch (err) {
    console.error("[shipping.webhook]", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
