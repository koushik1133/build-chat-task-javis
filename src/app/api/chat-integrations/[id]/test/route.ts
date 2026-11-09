import { NextRequest, NextResponse } from "next/server";
import { sendChat } from "@/lib/chatops/send";
import { getIntegrationRow } from "@/lib/chatops/subscriptions";
import { rateLimitAsync } from "@/lib/request-limits";
import { chatScope, isResponse } from "../../_shared";

export const dynamic = "force-dynamic";

/** POST: send a test message to the integration. */
export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const scope = await chatScope(true);
  if (isResponse(scope)) return scope;
  const { id } = await ctx.params;
  const rl = await rateLimitAsync(`chat:test:${scope.dataId}`, 10, 60_000);
  if (!rl.allowed) return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  const row = await getIntegrationRow(scope.dataId, id);
  if (!row) return NextResponse.json({ error: "Integration not found" }, { status: 404 });
  const result = await sendChat(id, { title: "KernelHub test message", text: "Chat notifications are connected.", eventType: "chat.test", fields: [{ label: "Integration", value: row.name }] }, { dataId: scope.dataId, bypassRate: true });
  return NextResponse.json({ ok: result.ok, status: result.status, error: result.error }, { status: result.ok ? 200 : 502 });
}
