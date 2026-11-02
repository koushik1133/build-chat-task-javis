import { NextResponse } from "next/server";
import { requireScope, scopeErrorResponse } from "@/lib/auth/scope";
import { getVapidConfig } from "@/lib/push/vapid";

export const dynamic = "force-dynamic";

/** GET /api/push/vapid-public → { configured, publicKey } for PushManager.subscribe. */
export async function GET() {
  try {
    await requireScope();
  } catch (err) {
    return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const cfg = getVapidConfig();
  return NextResponse.json({ configured: Boolean(cfg), publicKey: cfg?.publicKey ?? null }, { headers: { "Cache-Control": "no-store" } });
}
