import { NextRequest, NextResponse } from "next/server";
import { requireScope, scopeErrorResponse } from "@/lib/auth/scope";
import { rateLimit } from "@/lib/request-limits";
import { sendTestPing } from "@/lib/webhooks/dispatch";

export const runtime = "nodejs";

/** POST /api/webhooks/[id]/test — send a `webhook.test` ping now. */
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const scope = await requireScope({ area: "settings", edit: true });
    const { id } = await params;
    const rl = rateLimit(`webhook-test:${scope.dataId}`, 30, 60_000);
    if (!rl.allowed) return NextResponse.json({ error: "Too many test pings; try again in a minute." }, { status: 429 });
    const delivery = await sendTestPing(scope.dataId, id);
    return NextResponse.json({ delivery });
  } catch (err) {
    if (err instanceof Error && /not found/i.test(err.message)) return NextResponse.json({ error: "not_found" }, { status: 404 });
    if (err instanceof Error && /decrypt/i.test(err.message)) return NextResponse.json({ error: err.message }, { status: 422 });
    return scopeErrorResponse(err) ?? (console.error("[webhooks] test failed:", err), NextResponse.json({ error: "Could not send the test." }, { status: 500 }));
  }
}
