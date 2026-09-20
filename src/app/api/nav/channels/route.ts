import { NextResponse } from "next/server";
import { requireUser } from "@/lib/supabase/server";
import { buildChannelNav } from "@/lib/nav/channel-nav";

export const runtime = "nodejs";

/** GET /api/nav/channels — the caller's connected channels, for the sidebar. */
export async function GET() {
  let user;
  try { ({ user } = await requireUser()); }
  catch { return NextResponse.json({ error: "unauthorized" }, { status: 401 }); }

  const channels = await buildChannelNav(user.id);
  return NextResponse.json({ channels });
}
