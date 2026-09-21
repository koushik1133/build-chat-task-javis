import { NextResponse } from "next/server";
import { requireScope, scopeErrorResponse } from "@/lib/auth/scope";
import { buildChannelNav } from "@/lib/nav/channel-nav";

export const runtime = "nodejs";

/** GET /api/nav/channels — the caller's connected channels, for the sidebar. */
export async function GET() {
  let scope;
  try { scope = await requireScope({ area: "messaging", edit: false }); }
  catch (err) { return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 }); }

  const channels = await buildChannelNav(scope.dataId);
  return NextResponse.json({ channels });
}
